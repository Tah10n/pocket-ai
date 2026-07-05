import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { createStorage } from '../../src/services/storage';
import { ModelCatalogCacheStore } from '../../src/services/ModelCatalogCacheStore';

const STORAGE_ID = 'model-catalog-cache';
const SEARCH_CACHE_KEY = 'catalog-search-cache-v1';
const SNAPSHOT_CACHE_KEY = 'catalog-snapshot-cache-v1';

function clearCacheStorage() {
  createStorage(STORAGE_ID, { tier: 'cache' }).clearAll();
}

function buildModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'model',
    author: 'org',
    // The normalizer fills a lot of fields; we only need the ones used by cache sanitation.
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    ...overrides,
  } as any;
}

describe('ModelCatalogCacheStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    clearCacheStorage();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stores and returns cached search results, respecting maxAge', () => {
    const store = new ModelCatalogCacheStore();
    const scope = {
      query: 'q',
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon' as const,
    };

    expect(store.getSearch(scope, 1000)).toBeNull();

    store.putSearch(scope, {
      models: [buildModel({ id: 'a/model' })],
      hasMore: true,
      nextCursor: 'c1',
    });

    const fresh = store.getSearch(scope, 1000);
    expect(fresh).toEqual(expect.objectContaining({
      hasMore: true,
      nextCursor: 'c1',
      models: [expect.objectContaining({ id: 'a/model' })],
    }));

    jest.advanceTimersByTime(2000);
    expect(store.getSearch(scope, 1000)).toBeNull();
  });

  it('persists only anonymous search results; authenticated results stay in memory only', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    store.putSearch(anonScope, { models: [buildModel({ id: 'anon' })], hasMore: false, nextCursor: null });
    const persistedA = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    expect(persistedA.entries.every((entry: any) => entry.scope?.authScope === 'anon')).toBe(true);

    const authScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'auth' as const };
    store.putSearch(authScope, { models: [buildModel({ id: 'auth' })], hasMore: false, nextCursor: null });
    const persistedB = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    expect(persistedB.entries.every((entry: any) => entry.scope?.authScope === 'anon')).toBe(true);
  });

  it('sanitizes gated and private models in anonymous search caches', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };

    store.putSearch(anonScope, {
      models: [
        buildModel({ id: 'public/model' }),
        buildModel({
          id: 'gated/model',
          accessState: ModelAccessState.AUTHORIZED,
          isGated: true,
          resolvedFileName: 'secret.Q8_0.gguf',
          activeVariantId: 'secret.Q8_0.gguf',
          variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
        }),
        buildModel({
          id: 'private/model',
          accessState: ModelAccessState.AUTHORIZED,
          isPrivate: true,
          resolvedFileName: 'private.Q8_0.gguf',
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });

    const cached = store.getSearch(anonScope, 1000);
    expect(cached?.models.map((model) => model.id)).toEqual(['public/model', 'gated/model']);
    const gated = cached?.models.find((model) => model.id === 'gated/model');
    expect(gated).toEqual(expect.objectContaining({
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
    }));
    expect(gated?.resolvedFileName).toBeUndefined();
    expect(gated?.activeVariantId).toBeUndefined();
    expect(gated?.variants).toBeUndefined();

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(raw).toContain('public/model');
    expect(raw).toContain('gated/model');
    expect(raw).not.toContain('secret.Q8_0.gguf');
    expect(raw).not.toContain('private/model');
  });

  it('caps persisted public variants while preserving the active variant', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const variants = Array.from({ length: 14 }, (_value, index) => ({
      variantId: `model-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      fileName: `model-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      quantizationLabel: 'Q4_K_M',
      size: (index + 1) * 1024 * 1024 * 1024,
      isLocal: true,
    }));
    const activeVariant = {
      variantId: 'model-active.Q8_0.gguf',
      fileName: 'model-active.Q8_0.gguf',
      quantizationLabel: 'Q8_0',
      size: 16 * 1024 * 1024 * 1024,
      isLocal: true,
    };

    store.putSearch(anonScope, {
      models: [buildModel({
        id: 'public/large-variant-list',
        resolvedFileName: activeVariant.fileName,
        activeVariantId: activeVariant.variantId,
        variants: [...variants, activeVariant],
      })],
      hasMore: false,
      nextCursor: null,
    });

    const cached = store.getSearch(anonScope, 1000);
    const model = cached?.models[0];
    expect(model?.variants).toHaveLength(12);
    expect(model?.variants?.some((variant) => variant.fileName === activeVariant.fileName)).toBe(true);
    expect(model?.variants?.some((variant) => variant.isLocal === true)).toBe(false);

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    const persisted = JSON.parse(raw) as any;
    expect(persisted.version).toBe(4);
    expect(persisted.entries[0].result.models[0].variants).toHaveLength(12);
    expect(raw).toContain(activeVariant.fileName);
    expect(raw).not.toContain('isLocal');
  });

  it('strips local runtime fields from public anonymous cache entries', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };

    store.putSearch(anonScope, {
      models: [buildModel({
        id: 'public/downloaded-model',
        localPath: 'private-local-file.gguf',
        downloadedAt: 123,
        downloadIntegrity: {
          kind: 'sha256',
          sizeBytes: 123,
          checkedAt: 456,
          sha256: 'a'.repeat(64),
        },
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        metadataTrust: 'verified_local',
        sha256: 'a'.repeat(64),
        resumeData: 'resume-token',
      })],
      hasMore: false,
      nextCursor: null,
    });

    const cached = store.getSearch(anonScope, 1000);
    const model = cached?.models[0];
    expect(model).toEqual(expect.objectContaining({
      id: 'public/downloaded-model',
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    }));
    expect(model?.localPath).toBeUndefined();
    expect(model?.downloadedAt).toBeUndefined();
    expect(model?.downloadIntegrity).toBeUndefined();
    expect(model?.metadataTrust).toBeUndefined();
    expect(model?.sha256).toBeUndefined();
    expect(model?.resumeData).toBeUndefined();

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(raw).not.toContain('private-local-file.gguf');
    expect(raw).not.toContain('resume-token');
  });

  it('keeps vision catalog metadata but strips projector runtime from anonymous caches', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };

    store.putSearch(anonScope, {
      models: [buildModel({
        id: 'public/vision-model',
        chatModalities: ['text', 'vision'],
        artifactRole: 'primary_chat_model',
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        selectedProjectorId: 'projector-a',
        multimodalReadiness: {
          modelId: 'public/vision-model',
          status: 'ready',
          projectorId: 'projector-a',
          support: ['vision'],
          checkedAt: 123,
        },
        projectorCandidates: [{
          id: 'projector-a',
          ownerModelId: 'public/vision-model',
          repoId: 'public/vision-model',
          fileName: 'mmproj-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/public/vision-model/resolve/main/mmproj-model-f16.gguf',
          size: 1024,
          localPath: 'private-mmproj-model-f16.gguf',
          resumeData: 'private-mmproj-resume-token',
          lifecycleStatus: 'downloaded',
          matchStatus: 'failed',
          matchReason: 'download_verification_failed',
        }],
      })],
      hasMore: false,
      nextCursor: null,
    });

    const model = store.getSearch(anonScope, 1000)?.models[0];
    const projector = model?.projectorCandidates?.[0];

    expect(model).toEqual(expect.objectContaining({
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
    }));
    expect(model?.selectedProjectorId).toBeUndefined();
    expect(model?.multimodalReadiness).toBeUndefined();
    expect(projector).toEqual(expect.objectContaining({
      id: 'projector-a',
      lifecycleStatus: 'available',
      matchStatus: 'missing',
    }));
    expect(projector?.localPath).toBeUndefined();
    expect(projector?.resumeData).toBeUndefined();
    expect(projector?.matchReason).toBeUndefined();

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(raw).toContain('public/vision-model');
    expect(raw).toContain('mmproj-model-f16.gguf');
    expect(raw).not.toContain('private-mmproj-model-f16.gguf');
    expect(raw).not.toContain('private-mmproj-resume-token');
    expect(raw).not.toContain('download_verification_failed');
  });

  it('keeps audio-only catalog projector metadata across anonymous cache roundtrips', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const model = buildModel({
      id: 'public/audio-only-model',
      resolvedFileName: 'audio-model.Q4_K_M.gguf',
      chatModalities: ['text', 'audio'],
      artifactRole: 'primary_chat_model',
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'unknown',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'mmproj-audio-model-f16.gguf', confidence: 'medium' },
        ],
      },
      selectedProjectorId: 'projector-audio',
      multimodalReadiness: {
        modelId: 'public/audio-only-model',
        status: 'ready',
        projectorId: 'projector-audio',
        support: ['audio'],
        requestedSupport: ['audio'],
        checkedAt: 123,
      },
      projectorCandidates: [{
        id: 'projector-audio',
        ownerModelId: 'public/audio-only-model',
        repoId: 'public/audio-only-model',
        fileName: 'mmproj-audio-model-f16.gguf',
        downloadUrl: 'https://huggingface.co/public/audio-only-model/resolve/main/mmproj-audio-model-f16.gguf',
        size: 1024,
        localPath: 'private-mmproj-audio-model-f16.gguf',
        resumeData: 'private-mmproj-audio-resume-token',
        downloadProgress: 0.5,
        lifecycleStatus: 'downloaded',
        matchStatus: 'failed',
        matchReason: 'download_verification_failed',
      }],
      artifacts: [
        {
          id: 'main-audio-model',
          kind: 'main_model',
          requiredFor: ['text'],
          remoteFileName: 'audio-model.Q4_K_M.gguf',
          downloadUrl: 'https://huggingface.co/public/audio-only-model/resolve/main/audio-model.Q4_K_M.gguf',
          sizeBytes: 2048,
          localPath: 'private-main-audio-model.gguf',
          installState: 'installed',
          resumeData: 'private-main-audio-resume-token',
          downloadProgress: 1,
          errorCode: 'private-main-error',
          errorMessage: 'private main error',
        },
        {
          id: 'projector-audio',
          kind: 'multimodal_projector',
          requiredFor: ['audio'],
          remoteFileName: 'mmproj-audio-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/public/audio-only-model/resolve/main/mmproj-audio-model-f16.gguf',
          sizeBytes: 1024,
          localPath: 'private-artifact-mmproj-audio-model-f16.gguf',
          installState: 'installed',
          resumeData: 'private-artifact-mmproj-audio-resume-token',
          downloadProgress: 1,
          errorCode: 'private-projector-error',
          errorMessage: 'private projector error',
        },
      ],
    } as any);

    store.putSearch(anonScope, {
      models: [model],
      hasMore: false,
      nextCursor: null,
    });
    store.putModelSnapshots([model], 'anon');

    const reloadedStore = new ModelCatalogCacheStore();
    const searchModel = reloadedStore.getSearch(anonScope, 1000)?.models[0];
    const snapshotModel = reloadedStore.getModelSnapshot('public/audio-only-model', 'anon', 1000);
    const assertSanitizedAudioModel = (cachedModel: ModelMetadata | undefined | null) => {
      expect(cachedModel?.chatModalities).toEqual(['text', 'audio']);
      expect(cachedModel?.visionSource).toBeUndefined();
      expect(cachedModel?.visionConfidence).toBeUndefined();
      expect(cachedModel?.selectedProjectorId).toBeUndefined();
      expect(cachedModel?.multimodalReadiness).toBeUndefined();
      expect(cachedModel?.projectorCandidates).toHaveLength(1);
      expect(cachedModel?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
        id: 'projector-audio',
        fileName: 'mmproj-audio-model-f16.gguf',
        lifecycleStatus: 'available',
        matchStatus: 'missing',
      }));
      expect(cachedModel?.projectorCandidates?.[0]?.localPath).toBeUndefined();
      expect(cachedModel?.projectorCandidates?.[0]?.resumeData).toBeUndefined();
      expect(cachedModel?.projectorCandidates?.[0]?.downloadProgress).toBeUndefined();
      expect(cachedModel?.projectorCandidates?.[0]?.matchReason).toBeUndefined();

      const projectorArtifact = cachedModel?.artifacts?.find((artifact) => artifact.kind === 'multimodal_projector');
      expect(projectorArtifact).toEqual(expect.objectContaining({
        id: 'projector-audio',
        remoteFileName: 'mmproj-audio-model-f16.gguf',
        requiredFor: ['audio'],
        installState: 'remote',
      }));
      expect(projectorArtifact?.localPath).toBeUndefined();
      expect(projectorArtifact?.resumeData).toBeUndefined();
      expect(projectorArtifact?.downloadProgress).toBeUndefined();
      expect((projectorArtifact as any)?.errorCode).toBeUndefined();
      expect((projectorArtifact as any)?.errorMessage).toBeUndefined();
    };

    assertSanitizedAudioModel(searchModel);
    assertSanitizedAudioModel(snapshotModel);

    const rawSearch = storage.getString(SEARCH_CACHE_KEY) as string;
    const rawSnapshot = storage.getString(SNAPSHOT_CACHE_KEY) as string;
    expect(rawSearch).toContain('mmproj-audio-model-f16.gguf');
    expect(rawSnapshot).toContain('mmproj-audio-model-f16.gguf');
    for (const raw of [rawSearch, rawSnapshot]) {
      expect(raw).not.toContain('private-mmproj-audio-model-f16.gguf');
      expect(raw).not.toContain('private-mmproj-audio-resume-token');
      expect(raw).not.toContain('private-artifact-mmproj-audio-model-f16.gguf');
      expect(raw).not.toContain('private-artifact-mmproj-audio-resume-token');
      expect(raw).not.toContain('private-projector-error');
      expect(raw).not.toContain('download_verification_failed');
    }
  });

  it('drops audio projector metadata when anonymous provenance is runtime-only or lacks projector evidence', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const projectorCandidate = (modelId: string, fileName: string) => ({
      id: `${modelId}-projector`,
      ownerModelId: modelId,
      repoId: modelId,
      fileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${fileName}`,
      size: 1024,
      localPath: `private-${fileName}`,
      resumeData: `private-${fileName}-resume-token`,
      downloadProgress: 0.5,
      lifecycleStatus: 'downloaded' as const,
      matchStatus: 'matched' as const,
      matchReason: 'single_projector_candidate',
    });
    const projectorArtifact = (modelId: string, fileName: string) => ({
      id: `${modelId}-projector`,
      kind: 'multimodal_projector' as const,
      requiredFor: ['audio' as const],
      remoteFileName: fileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${fileName}`,
      sizeBytes: 1024,
      localPath: `private-artifact-${fileName}`,
      installState: 'installed' as const,
      resumeData: `private-artifact-${fileName}-resume-token`,
      downloadProgress: 1,
      errorCode: `private-${fileName}-error`,
    });
    const runtimeOnlyModel = buildModel({
      id: 'public/runtime-only-audio-model',
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'unknown',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [
          { source: 'runtime', value: 'audio', confidence: 'high' },
          { source: 'projector', value: 'mmproj-runtime-audio-model-f16.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [projectorCandidate('public/runtime-only-audio-model', 'mmproj-runtime-audio-model-f16.gguf')],
      artifacts: [projectorArtifact('public/runtime-only-audio-model', 'mmproj-runtime-audio-model-f16.gguf')],
    } as any);
    const missingProjectorEvidenceModel = buildModel({
      id: 'public/missing-projector-evidence-audio-model',
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'unknown',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
        ],
      },
      projectorCandidates: [projectorCandidate('public/missing-projector-evidence-audio-model', 'mmproj-missing-projector-evidence-f16.gguf')],
      artifacts: [projectorArtifact('public/missing-projector-evidence-audio-model', 'mmproj-missing-projector-evidence-f16.gguf')],
    } as any);

    store.putSearch(anonScope, {
      models: [runtimeOnlyModel, missingProjectorEvidenceModel],
      hasMore: false,
      nextCursor: null,
    });
    store.putModelSnapshots([runtimeOnlyModel, missingProjectorEvidenceModel], 'anon');

    const reloadedStore = new ModelCatalogCacheStore();
    const searchModels = reloadedStore.getSearch(anonScope, 1000)?.models ?? [];
    const snapshotModels = [
      reloadedStore.getModelSnapshot('public/runtime-only-audio-model', 'anon', 1000),
      reloadedStore.getModelSnapshot('public/missing-projector-evidence-audio-model', 'anon', 1000),
    ];
    for (const cachedModel of [...searchModels, ...snapshotModels]) {
      expect(cachedModel?.chatModalities).toEqual(['text', 'audio']);
      expect(cachedModel?.projectorCandidates).toBeUndefined();
      expect(cachedModel?.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector')).not.toBe(true);
      expect(cachedModel?.selectedProjectorId).toBeUndefined();
      expect(cachedModel?.multimodalReadiness).toBeUndefined();
    }

    const rawSearch = storage.getString(SEARCH_CACHE_KEY) as string;
    const rawSnapshot = storage.getString(SNAPSHOT_CACHE_KEY) as string;
    for (const raw of [rawSearch, rawSnapshot]) {
      expect(raw).not.toContain('projectorCandidates');
      expect(raw).not.toContain('multimodal_projector');
      expect(raw).not.toContain('mmproj-missing-projector-evidence-f16.gguf');
      expect(raw).not.toContain('private-mmproj-runtime-audio-model-f16.gguf');
      expect(raw).not.toContain('private-mmproj-missing-projector-evidence-f16.gguf');
      expect(raw).not.toContain('private-artifact-mmproj-runtime-audio-model-f16.gguf');
      expect(raw).not.toContain('private-artifact-mmproj-missing-projector-evidence-f16.gguf');
    }
  });

  it('keeps deterministic filename affinity ambiguity across anonymous cache roundtrips', () => {
    const store = new ModelCatalogCacheStore();
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const model = buildModel({
      id: 'public/vision-affinity-model',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      selectedProjectorId: 'projector-selected',
      projectorCandidates: [
        {
          id: 'projector-selected',
          ownerModelId: 'public/vision-affinity-model',
          repoId: 'public/vision-affinity-model',
          fileName: 'mmproj-selected-f16.gguf',
          downloadUrl: 'https://huggingface.co/public/vision-affinity-model/resolve/main/mmproj-selected-f16.gguf',
          size: 1024,
          localPath: 'private-mmproj-selected-f16.gguf',
          resumeData: 'private-mmproj-selected-resume-token',
          lifecycleStatus: 'downloaded',
          matchStatus: 'matched',
          matchReason: 'deterministic_filename_affinity',
        },
        {
          id: 'projector-ambiguous',
          ownerModelId: 'public/vision-affinity-model',
          repoId: 'public/vision-affinity-model',
          fileName: 'mmproj-ambiguous-f16.gguf',
          downloadUrl: 'https://huggingface.co/public/vision-affinity-model/resolve/main/mmproj-ambiguous-f16.gguf',
          size: 2048,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
          matchReason: 'deterministic_filename_affinity',
        },
      ],
    });
    const expectSanitizedAffinityProjectors = (projectors: ModelMetadata['projectorCandidates']) => {
      expect(projectors).toHaveLength(2);
      const selected = projectors?.find((projector) => projector.id === 'projector-selected');
      const ambiguous = projectors?.find((projector) => projector.id === 'projector-ambiguous');

      expect(selected).toEqual(expect.objectContaining({
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'deterministic_filename_affinity',
      }));
      expect(selected?.localPath).toBeUndefined();
      expect(selected?.resumeData).toBeUndefined();
      expect(ambiguous).toEqual(expect.objectContaining({
        lifecycleStatus: 'available',
        matchStatus: 'ambiguous',
        matchReason: 'deterministic_filename_affinity',
      }));
    };

    store.putSearch(anonScope, {
      models: [model],
      hasMore: false,
      nextCursor: null,
    });
    store.putModelSnapshots([model], 'anon');

    const reloadedStore = new ModelCatalogCacheStore();
    const searchModel = reloadedStore.getSearch(anonScope, 1000)?.models[0];
    const snapshotModel = reloadedStore.getModelSnapshot('public/vision-affinity-model', 'anon', 1000);

    expect(searchModel?.selectedProjectorId).toBeUndefined();
    expect(snapshotModel?.selectedProjectorId).toBeUndefined();
    expectSanitizedAffinityProjectors(searchModel?.projectorCandidates);
    expectSanitizedAffinityProjectors(snapshotModel?.projectorCandidates);
  });

  it('strips variant-level projector runtime from anonymous caches', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const model = buildModel({
      id: 'public/vision-variant-model',
      variants: [
        {
          variantId: 'q4',
          fileName: 'model-q4.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 1024,
          isLocal: true,
          chatModalities: ['text', 'vision'],
          artifactRole: 'primary_chat_model',
          visionSource: 'catalog_metadata',
          visionConfidence: 'trusted',
          selectedProjectorId: 'variant-projector',
          projectorCandidates: [
            {
              id: 'variant-projector',
              ownerModelId: 'public/vision-variant-model',
              ownerVariantId: 'q4',
              repoId: 'public/vision-variant-model',
              fileName: 'mmproj-model-q4.gguf',
              downloadUrl: 'https://huggingface.co/public/vision-variant-model/resolve/main/mmproj-model-q4.gguf',
              size: 2048,
              localPath: 'private-mmproj-model-q4.gguf',
              resumeData: 'private-mmproj-model-q4-resume-token',
              lifecycleStatus: 'downloaded',
              matchStatus: 'matched',
              matchReason: 'single_projector_candidate',
            },
          ],
        },
      ],
    });
    const expectSanitizedVariant = (variant: NonNullable<ModelMetadata['variants']>[number] | undefined) => {
      expect(variant?.isLocal).toBeUndefined();
      expect(variant?.selectedProjectorId).toBeUndefined();
      expect(variant?.chatModalities).toEqual(['text', 'vision']);
      expect(variant?.visionSource).toBe('catalog_metadata');
      expect(variant?.visionConfidence).toBe('trusted');
      expect(variant?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
        id: 'variant-projector',
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'single_projector_candidate',
      }));
      expect(variant?.projectorCandidates?.[0]?.localPath).toBeUndefined();
      expect(variant?.projectorCandidates?.[0]?.resumeData).toBeUndefined();
    };

    store.putSearch(anonScope, {
      models: [model],
      hasMore: false,
      nextCursor: null,
    });
    store.putModelSnapshots([model], 'anon');

    const reloadedStore = new ModelCatalogCacheStore();
    const searchVariant = reloadedStore.getSearch(anonScope, 1000)?.models[0]?.variants?.[0];
    const snapshotVariant = reloadedStore.getModelSnapshot('public/vision-variant-model', 'anon', 1000)?.variants?.[0];

    expectSanitizedVariant(searchVariant);
    expectSanitizedVariant(snapshotVariant);
    expect(storage.getString(SEARCH_CACHE_KEY)).not.toContain('private-mmproj-model-q4.gguf');
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).not.toContain('private-mmproj-model-q4.gguf');
    expect(storage.getString(SEARCH_CACHE_KEY)).not.toContain('private-mmproj-model-q4-resume-token');
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).not.toContain('private-mmproj-model-q4-resume-token');
  });

  it('strips local-only vision provenance from anonymous snapshots', () => {
    const store = new ModelCatalogCacheStore();

    store.putModelSnapshots([buildModel({
      id: 'public/local-runtime-vision-model',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'user_selected_projector',
      visionConfidence: 'verified',
      selectedProjectorId: 'local-projector',
      multimodalReadiness: {
        modelId: 'public/local-runtime-vision-model',
        status: 'ready',
        projectorId: 'local-projector',
        support: ['vision'],
        checkedAt: 123,
      },
    })], 'anon');

    const snapshot = store.getModelSnapshot('public/local-runtime-vision-model', 'anon', 1000);

    expect(snapshot?.chatModalities).toEqual(['text']);
    expect(snapshot?.visionSource).toBeUndefined();
    expect(snapshot?.visionConfidence).toBeUndefined();
    expect(snapshot?.selectedProjectorId).toBeUndefined();
    expect(snapshot?.multimodalReadiness).toBeUndefined();
  });

  it('drops unsafe projector candidates from anonymous caches', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };

    store.putSearch(anonScope, {
      models: [buildModel({
        id: 'public/local-projector-vision-model',
        chatModalities: ['text', 'vision'],
        artifactRole: 'primary_chat_model',
        visionSource: 'user_selected_projector',
        visionConfidence: 'verified',
        projectorCandidates: [{
          id: 'local-projector',
          ownerModelId: 'public/local-projector-vision-model',
          repoId: 'public/local-projector-vision-model',
          fileName: 'local-mmproj.gguf',
          downloadUrl: 'file:///private/local-mmproj.gguf',
          size: 1024,
          localPath: 'private-local-mmproj.gguf',
          lifecycleStatus: 'downloaded',
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        }],
      })],
      hasMore: false,
      nextCursor: null,
    });

    const model = store.getSearch(anonScope, 1000)?.models[0];
    expect(model?.chatModalities).toEqual(['text']);
    expect(model?.visionSource).toBeUndefined();
    expect(model?.visionConfidence).toBeUndefined();
    expect(model?.projectorCandidates).toBeUndefined();

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(raw).not.toContain('local-mmproj.gguf');
    expect(raw).not.toContain('private-local-mmproj.gguf');
    expect(raw).not.toContain('user_selected_projector');
  });

  it('rewrites existing anonymous payloads with unsafe vision provenance during hydration', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const searchScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const unsafeSearchModel = buildModel({
      id: 'public/unsafe-search-vision',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'runtime_probe',
      visionConfidence: 'verified',
    });
    const unsafeSnapshotModel = buildModel({
      id: 'public/unsafe-snapshot-vision',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'user_selected_projector',
      visionConfidence: 'trusted',
    });

    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [{
        key: 'q::__initial__::20::__default__::anon',
        timestamp: Date.now(),
        scope: searchScope,
        result: {
          models: [unsafeSearchModel],
          hasMore: false,
          nextCursor: null,
        },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [{
        key: 'public/unsafe-snapshot-vision::anon',
        id: 'public/unsafe-snapshot-vision',
        authScope: 'anon',
        timestamp: Date.now(),
        model: unsafeSnapshotModel,
      }],
    }));

    const store = new ModelCatalogCacheStore();
    const searchModel = store.getSearch(searchScope, 1000)?.models[0];
    const snapshotModel = store.getModelSnapshot('public/unsafe-snapshot-vision', 'anon', 1000);

    expect(searchModel?.chatModalities).toEqual(['text']);
    expect(searchModel?.visionSource).toBeUndefined();
    expect(searchModel?.visionConfidence).toBeUndefined();
    expect(snapshotModel?.chatModalities).toEqual(['text']);
    expect(snapshotModel?.visionSource).toBeUndefined();
    expect(snapshotModel?.visionConfidence).toBeUndefined();

    const persistedSearch = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    const persistedSnapshot = JSON.parse(storage.getString(SNAPSHOT_CACHE_KEY) as string) as any;
    expect(persistedSearch.entries[0].result.models[0].chatModalities).toEqual(['text']);
    expect(persistedSearch.entries[0].result.models[0].visionSource).toBeUndefined();
    expect(persistedSearch.entries[0].result.models[0].visionConfidence).toBeUndefined();
    expect(persistedSnapshot.entries[0].model.chatModalities).toEqual(['text']);
    expect(persistedSnapshot.entries[0].model.visionSource).toBeUndefined();
    expect(persistedSnapshot.entries[0].model.visionConfidence).toBeUndefined();
  });

  it('rewrites existing anonymous payloads with only projector resume data during hydration', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const searchScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const legacySearchModel = buildModel({
      id: 'public/legacy-search-projector-resume',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      projectorCandidates: [{
        id: 'search-projector',
        ownerModelId: 'public/legacy-search-projector-resume',
        repoId: 'public/legacy-search-projector-resume',
        fileName: 'mmproj-search-f16.gguf',
        downloadUrl: 'https://huggingface.co/public/legacy-search-projector-resume/resolve/main/mmproj-search-f16.gguf',
        size: 1024,
        resumeData: 'legacy-search-projector-resume-token',
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'single_projector_candidate',
      }],
    });
    const legacySnapshotModel = buildModel({
      id: 'public/legacy-variant-projector-resume',
      variants: [{
        variantId: 'q4',
        fileName: 'model-q4.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1024,
        chatModalities: ['text', 'vision'],
        artifactRole: 'primary_chat_model',
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        projectorCandidates: [{
          id: 'variant-projector',
          ownerModelId: 'public/legacy-variant-projector-resume',
          ownerVariantId: 'q4',
          repoId: 'public/legacy-variant-projector-resume',
          fileName: 'mmproj-variant-f16.gguf',
          downloadUrl: 'https://huggingface.co/public/legacy-variant-projector-resume/resolve/main/mmproj-variant-f16.gguf',
          size: 2048,
          resumeData: 'legacy-variant-projector-resume-token',
          lifecycleStatus: 'available',
          matchStatus: 'matched',
          matchReason: 'single_projector_candidate',
        }],
      }],
    });

    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [{
        key: 'q::__initial__::20::__default__::anon',
        timestamp: Date.now(),
        scope: searchScope,
        result: {
          models: [legacySearchModel],
          hasMore: false,
          nextCursor: null,
        },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [{
        key: 'public/legacy-variant-projector-resume::anon',
        id: 'public/legacy-variant-projector-resume',
        authScope: 'anon',
        timestamp: Date.now(),
        model: legacySnapshotModel,
      }],
    }));

    const store = new ModelCatalogCacheStore();
    const searchProjector = store.getSearch(searchScope, 1000)?.models[0]?.projectorCandidates?.[0];
    const snapshotVariantProjector = store
      .getModelSnapshot('public/legacy-variant-projector-resume', 'anon', 1000)
      ?.variants?.[0]
      ?.projectorCandidates?.[0];

    expect(searchProjector).toEqual(expect.objectContaining({
      id: 'search-projector',
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    }));
    expect(searchProjector?.resumeData).toBeUndefined();
    expect(snapshotVariantProjector).toEqual(expect.objectContaining({
      id: 'variant-projector',
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    }));
    expect(snapshotVariantProjector?.resumeData).toBeUndefined();

    expect(storage.getString(SEARCH_CACHE_KEY)).not.toContain('legacy-search-projector-resume-token');
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).not.toContain('legacy-variant-projector-resume-token');
  });

  it('rewrites existing anonymous payloads with only projector download progress during hydration', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const searchScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const legacySearchModel = buildModel({
      id: 'public/legacy-search-projector-progress',
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      projectorCandidates: [{
        id: 'search-projector',
        ownerModelId: 'public/legacy-search-projector-progress',
        repoId: 'public/legacy-search-projector-progress',
        fileName: 'mmproj-search-f16.gguf',
        downloadUrl: 'https://huggingface.co/public/legacy-search-projector-progress/resolve/main/mmproj-search-f16.gguf',
        size: 1024,
        downloadProgress: 0,
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'single_projector_candidate',
      }],
    });
    const legacySnapshotModel = buildModel({
      id: 'public/legacy-variant-projector-progress',
      variants: [{
        variantId: 'q4',
        fileName: 'model-q4.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1024,
        chatModalities: ['text', 'vision'],
        artifactRole: 'primary_chat_model',
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        projectorCandidates: [{
          id: 'variant-projector',
          ownerModelId: 'public/legacy-variant-projector-progress',
          ownerVariantId: 'q4',
          repoId: 'public/legacy-variant-projector-progress',
          fileName: 'mmproj-variant-f16.gguf',
          downloadUrl: 'https://huggingface.co/public/legacy-variant-projector-progress/resolve/main/mmproj-variant-f16.gguf',
          size: 2048,
          downloadProgress: 0,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
          matchReason: 'single_projector_candidate',
        }],
      }],
    });

    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [{
        key: 'q::__initial__::20::__default__::anon',
        timestamp: Date.now(),
        scope: searchScope,
        result: {
          models: [legacySearchModel],
          hasMore: false,
          nextCursor: null,
        },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [{
        key: 'public/legacy-variant-projector-progress::anon',
        id: 'public/legacy-variant-projector-progress',
        authScope: 'anon',
        timestamp: Date.now(),
        model: legacySnapshotModel,
      }],
    }));

    const store = new ModelCatalogCacheStore();
    const searchProjector = store.getSearch(searchScope, 1000)?.models[0]?.projectorCandidates?.[0];
    const snapshotVariantProjector = store
      .getModelSnapshot('public/legacy-variant-projector-progress', 'anon', 1000)
      ?.variants?.[0]
      ?.projectorCandidates?.[0];
    const persistedSearch = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    const persistedSnapshot = JSON.parse(storage.getString(SNAPSHOT_CACHE_KEY) as string) as any;

    expect(searchProjector?.downloadProgress).toBeUndefined();
    expect(snapshotVariantProjector?.downloadProgress).toBeUndefined();
    expect(persistedSearch.entries[0].result.models[0].projectorCandidates[0].downloadProgress).toBeUndefined();
    expect(persistedSnapshot.entries[0].model.variants[0].projectorCandidates[0].downloadProgress).toBeUndefined();
  });

  it('migrates version 3 search payloads to version 4 with variant limiting', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const scope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const variants = Array.from({ length: 14 }, (_value, index) => ({
      variantId: `legacy-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      fileName: `legacy-${String(index).padStart(2, '0')}.Q4_K_M.gguf`,
      quantizationLabel: 'Q4_K_M',
      size: (index + 1) * 1024,
    }));
    const activeVariant = {
      variantId: 'legacy-active.Q8_0.gguf',
      fileName: 'legacy-active.Q8_0.gguf',
      quantizationLabel: 'Q8_0',
      size: 16 * 1024,
    };

    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 3,
      entries: [{
        key: 'q::__initial__::20::__default__::anon',
        timestamp: Date.now(),
        scope,
        result: {
          models: [buildModel({
            id: 'public/legacy-large-variant-list',
            resolvedFileName: activeVariant.fileName,
            activeVariantId: activeVariant.variantId,
            variants: [...variants, activeVariant],
          })],
          hasMore: false,
          nextCursor: null,
        },
      }],
    }));

    const store = new ModelCatalogCacheStore();
    const cached = store.getSearch(scope, 1000);
    const model = cached?.models[0];
    expect(model?.variants).toHaveLength(12);
    expect(model?.variants?.some((variant) => variant.fileName === activeVariant.fileName)).toBe(true);
    expect(model?.variants?.some((variant) => variant.isLocal === true)).toBe(false);

    const persisted = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    expect(persisted.version).toBe(4);
    expect(persisted.entries[0].result.models[0].variants).toHaveLength(12);
    expect(persisted.entries[0].result.models[0].variants.some(
      (variant: any) => variant.fileName === activeVariant.fileName,
    )).toBe(true);
    expect(storage.getString(SEARCH_CACHE_KEY)).not.toContain('isLocal');
  });

  it('prunes old search entries beyond MAX_PERSISTED_SEARCH_ENTRIES', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    for (let i = 0; i < 10; i += 1) {
      jest.setSystemTime(new Date(`2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
      store.putSearch(
        { query: `q${i}`, cursor: null, pageSize: 20, sort: null, authScope: 'anon' },
        { models: [buildModel({ id: `m${i}` })], hasMore: false, nextCursor: null },
      );
    }

    const persisted = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    expect(persisted.entries).toHaveLength(6);

    const queries = persisted.entries.map((entry: any) => entry.scope?.query);
    expect(queries).toEqual(['q9', 'q8', 'q7', 'q6', 'q5', 'q4']);
  });

  it('stores and returns model snapshots and respects authScope persistence', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    store.putModelSnapshots([buildModel({ id: 'snap-a' })], 'anon');
    expect(store.getModelSnapshot('snap-a', 'anon', 1000)?.id).toBe('snap-a');
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toContain('snap-a');

    store.putModelSnapshots([buildModel({ id: 'snap-b', accessState: ModelAccessState.AUTHORIZED })], 'auth');
    expect(store.getModelSnapshot('snap-b', 'auth', 1000)?.id).toBe('snap-b');
    const raw = storage.getString(SNAPSHOT_CACHE_KEY) as string;
    expect(raw).toContain('snap-a');
    expect(raw).not.toContain('snap-b');

    const reloadedStore = new ModelCatalogCacheStore();
    expect(reloadedStore.getModelSnapshot('snap-a', 'anon', 1000)?.id).toBe('snap-a');
    expect(reloadedStore.getModelSnapshot('snap-b', 'auth', 1000)).toBeNull();
  });

  it('loads persisted payloads, drops invalid versions, and strips anonymous auth states', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    // invalid payload should be removed
    storage.set(SEARCH_CACHE_KEY, '{not-json');

    // snapshot payload with AUTHORIZED model stored under anon should be sanitized
    const now = Date.now();
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [
        {
          id: 'gated/model',
          authScope: 'anon',
          timestamp: now,
          model: {
            id: 'gated/model',
            accessState: ModelAccessState.AUTHORIZED,
            isGated: true,
            isPrivate: false,
            resolvedFileName: 'secret.Q8_0.gguf',
            activeVariantId: 'secret.Q8_0.gguf',
            variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
          },
        },
        {
          id: 'private/model',
          authScope: 'anon',
          timestamp: now,
          model: {
            id: 'private/model',
            accessState: ModelAccessState.AUTHORIZED,
            isGated: false,
            isPrivate: true,
          },
        },
      ],
    }));

    const store = new ModelCatalogCacheStore();

    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();

    const snapshot = store.getModelSnapshot('gated/model', 'anon', 1000);
    expect(snapshot?.accessState).toBe(ModelAccessState.AUTH_REQUIRED);
    expect(snapshot?.resolvedFileName).toBeUndefined();
    expect(snapshot?.activeVariantId).toBeUndefined();
    expect(snapshot?.variants).toBeUndefined();
    expect(store.getModelSnapshot('private/model', 'anon', 1000)).toBeNull();
  });

  it('drops legacy version 2 search payloads to clear auth-derived anonymous query caches', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const legacyScope = {
      query: 'private-org/exact-repo',
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon' as const,
    };

    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 2,
      entries: [{
        key: 'private-org/exact-repo::null::20::null::anon',
        timestamp: Date.now(),
        scope: legacyScope,
        result: {
          models: [buildModel({ id: 'private-org/exact-repo' })],
          hasMore: false,
          nextCursor: null,
        },
      }],
    }));

    const store = new ModelCatalogCacheStore();

    expect(store.getSearch(legacyScope, 1000)).toBeNull();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();
  });

  it('migrates version 3 snapshot payloads to version 4 with anonymous sanitization', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 3,
      entries: [
        {
          id: 'legacy/gated-snapshot',
          authScope: 'anon',
          timestamp: Date.now(),
          model: buildModel({
            id: 'legacy/gated-snapshot',
            accessState: ModelAccessState.AUTHORIZED,
            isGated: true,
            isPrivate: false,
            resolvedFileName: 'secret.Q8_0.gguf',
            activeVariantId: 'secret.Q8_0.gguf',
            variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
          }),
        },
        {
          id: 'legacy/private-snapshot',
          authScope: 'anon',
          timestamp: Date.now(),
          model: buildModel({
            id: 'legacy/private-snapshot',
            accessState: ModelAccessState.AUTHORIZED,
            isPrivate: true,
          }),
        },
      ],
    }));

    const store = new ModelCatalogCacheStore();

    const snapshot = store.getModelSnapshot('legacy/gated-snapshot', 'anon', 1000);
    expect(snapshot).toEqual(expect.objectContaining({
      id: 'legacy/gated-snapshot',
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
    }));
    expect(snapshot?.resolvedFileName).toBeUndefined();
    expect(snapshot?.activeVariantId).toBeUndefined();
    expect(snapshot?.variants).toBeUndefined();
    expect(store.getModelSnapshot('legacy/private-snapshot', 'anon', 1000)).toBeNull();

    const raw = storage.getString(SNAPSHOT_CACHE_KEY) as string;
    const persisted = JSON.parse(raw) as any;
    expect(persisted.version).toBe(4);
    expect(raw).toContain('legacy/gated-snapshot');
    expect(raw).not.toContain('secret.Q8_0.gguf');
    expect(raw).not.toContain('legacy/private-snapshot');
  });

  it('strips inaccessible anonymous snapshots before storing them in memory or persistence', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    store.putModelSnapshots([
      buildModel({
        id: 'gated/snapshot',
        accessState: ModelAccessState.AUTHORIZED,
        isGated: true,
        resolvedFileName: 'secret.Q8_0.gguf',
        activeVariantId: 'secret.Q8_0.gguf',
        variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
      }),
      buildModel({
        id: 'private/snapshot',
        accessState: ModelAccessState.AUTHORIZED,
        isPrivate: true,
      }),
    ], 'anon');

    const cached = store.getModelSnapshot('gated/snapshot', 'anon', 1000);
    expect(cached).toEqual(expect.objectContaining({
      id: 'gated/snapshot',
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
    }));
    expect(cached?.resolvedFileName).toBeUndefined();
    expect(cached?.activeVariantId).toBeUndefined();
    expect(cached?.variants).toBeUndefined();
    expect(store.getModelSnapshot('private/snapshot', 'anon', 1000)).toBeNull();

    const raw = storage.getString(SNAPSHOT_CACHE_KEY) as string;
    expect(raw).toContain('gated/snapshot');
    expect(raw).not.toContain('secret.Q8_0.gguf');
    expect(raw).not.toContain('private/snapshot');
  });

  it('deletes stale anonymous snapshots when a model becomes private', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    store.putModelSnapshots([
      buildModel({
        id: 'stale/private',
        resolvedFileName: 'public.Q4_K_M.gguf',
        activeVariantId: 'public.Q4_K_M.gguf',
      }),
    ], 'anon');
    expect(store.getModelSnapshot('stale/private', 'anon', 1000)).toEqual(expect.objectContaining({
      resolvedFileName: 'public.Q4_K_M.gguf',
    }));

    store.deleteModelSnapshots(['stale/private'], 'anon');

    expect(store.getModelSnapshot('stale/private', 'anon', 1000)).toBeNull();
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).not.toContain('stale/private');
  });

  it('reconciles existing anonymous search entries when auth metadata changes visibility', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const anonScope = { query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };

    store.putSearch(anonScope, {
      models: [
        buildModel({ id: 'public/model' }),
        buildModel({
          id: 'stale/gated',
          resolvedFileName: 'stale-gated.Q8_0.gguf',
          activeVariantId: 'stale-gated.Q8_0.gguf',
          variants: [{ variantId: 'stale-gated.Q8_0.gguf', fileName: 'stale-gated.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
        }),
        buildModel({
          id: 'stale/private',
          resolvedFileName: 'stale-private.Q8_0.gguf',
          activeVariantId: 'stale-private.Q8_0.gguf',
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });

    store.reconcileAnonymousSearchModels([
      buildModel({
        id: 'stale/gated',
        accessState: ModelAccessState.AUTHORIZED,
        isGated: true,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        resolvedFileName: 'secret.Q8_0.gguf',
        activeVariantId: 'secret.Q8_0.gguf',
        variants: [{ variantId: 'secret.Q8_0.gguf', fileName: 'secret.Q8_0.gguf', quantizationLabel: 'Q8_0', size: 10 }],
      }),
      buildModel({
        id: 'stale/private',
        accessState: ModelAccessState.AUTHORIZED,
        isPrivate: true,
        resolvedFileName: 'private.Q8_0.gguf',
      }),
    ]);

    const cached = store.getSearch(anonScope, 1000);
    expect(cached?.models.map((model) => model.id)).toEqual(['public/model', 'stale/gated']);
    const gated = cached?.models.find((model) => model.id === 'stale/gated');
    expect(gated).toEqual(expect.objectContaining({
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    }));
    expect(gated?.resolvedFileName).toBeUndefined();
    expect(gated?.activeVariantId).toBeUndefined();
    expect(gated?.variants).toBeUndefined();

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(raw).not.toContain('stale-gated.Q8_0.gguf');
    expect(raw).not.toContain('stale-private');
  });

  it('reports persisted size and supports clearing caches', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });

    store.putSearch({ query: 'q', cursor: null, pageSize: 20, sort: null, authScope: 'anon' }, {
      models: [buildModel({ id: 'x' })],
      hasMore: false,
      nextCursor: null,
    });
    store.putModelSnapshots([buildModel({ id: 'y' })], 'anon');

    expect(store.getPersistedSizeBytes()).toBeGreaterThan(0);

    store.clearSnapshots();
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBeUndefined();
    expect(store.getModelSnapshot('y', 'anon', 1000)).toBeNull();

    store.clearAll();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBeUndefined();
  });
});
