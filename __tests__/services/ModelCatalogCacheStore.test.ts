import {
  EngineStatus,
  LifecycleStatus,
  ModelAccessState,
  type ModelArtifactRequiredInput,
  type ModelMetadata,
} from '../../src/types/models';
import { createStorage } from '../../src/services/storage';
import {
  MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES,
  MODEL_CATALOG_CACHE_PERSISTED_VERSION,
  ModelCatalogCacheStore,
  sanitizeCatalogModelRuntimeState,
} from '../../src/services/ModelCatalogCacheStore';
import {
  resolveEffectiveActiveVariantNativeSupport,
  resolveModelNativeMultimodalSupport,
} from '../../src/utils/modelCapabilities';
import {
  inputCapabilityEvidenceSupportsModality,
  resolveEffectiveInputCapabilities,
} from '../../src/utils/modelInputCapabilities';
import { buildHuggingFaceResolveUrl } from '../../src/utils/huggingFaceUrls';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
} from '../../src/utils/modelProjectors';

const STORAGE_ID = 'model-catalog-cache';
const SEARCH_CACHE_KEY = 'catalog-search-cache-v1';
const SNAPSHOT_CACHE_KEY = 'catalog-snapshot-cache-v1';
const CACHE_MAINTENANCE_VERSION_KEY = 'catalog-cache-maintenance-version';

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

function buildProjectorCandidate(
  modelId: string,
  id: string,
  fileName: string,
  options: {
    localOnly?: boolean;
    ownerModelId?: string;
    repoId?: string;
    revision?: string;
  } = {},
): NonNullable<ModelMetadata['projectorCandidates']>[number] {
  const repoId = options.repoId ?? modelId;
  const revision = options.revision ?? 'main';
  return {
    id,
    ownerModelId: options.ownerModelId ?? modelId,
    repoId,
    fileName,
    downloadUrl: options.localOnly
      ? `file:///private/${fileName}`
      : buildHuggingFaceResolveUrl(repoId, fileName, revision),
    ...(options.revision ? { hfRevision: revision } : {}),
    size: 1024,
    localPath: `private-${fileName}`,
    lifecycleStatus: 'downloaded',
    matchStatus: 'matched',
    matchReason: 'single_projector_candidate',
  };
}

function buildProjectorArtifact(
  modelId: string,
  id: string,
  fileName: string,
  requiredFor: ModelArtifactRequiredInput[],
  options: { localOnly?: boolean; repoId?: string; revision?: string } = {},
): NonNullable<ModelMetadata['artifacts']>[number] {
  const repoId = options.repoId ?? modelId;
  const revision = options.revision ?? 'main';
  return {
    id,
    kind: 'multimodal_projector',
    requiredFor,
    remoteFileName: fileName,
    downloadUrl: options.localOnly
      ? `file:///private/${fileName}`
      : buildHuggingFaceResolveUrl(repoId, fileName, revision),
    ...(options.revision ? { hfRevision: revision } : {}),
    sizeBytes: 1024,
    localPath: `private-artifact-${fileName}`,
    installState: 'installed',
  };
}

function roundTripAnonymousModel(model: ModelMetadata): [ModelMetadata, ModelMetadata] {
  const scope = {
    query: model.id,
    cursor: null,
    pageSize: 20,
    sort: null,
    authScope: 'anon' as const,
  };
  const store = new ModelCatalogCacheStore();
  store.putSearch(scope, { models: [model], hasMore: false, nextCursor: null });
  store.putModelSnapshots([model], 'anon');
  const reloadedStore = new ModelCatalogCacheStore();
  const searchModel = reloadedStore.getSearch(scope, 1000)?.models[0];
  const snapshotModel = reloadedStore.getModelSnapshot(model.id, 'anon', 1000);
  expect(searchModel).toBeDefined();
  expect(snapshotModel).toBeDefined();
  expect(snapshotModel).not.toBeNull();
  return [searchModel as ModelMetadata, snapshotModel as ModelMetadata];
}

function getCurrentProjectorId(
  projector: NonNullable<ModelMetadata['projectorCandidates']>[number],
): string {
  return buildProjectorArtifactId({
    repoId: projector.repoId,
    hfRevision: projector.hfRevision,
    fileName: projector.fileName,
    ownerVariantId: projector.ownerVariantId,
  });
}

function hydrateLegacyAnonymousModel(
  model: ModelMetadata,
  persistedVersion = 7,
): [ModelMetadata | undefined, ModelMetadata | null] {
  const storage = createStorage(STORAGE_ID, { tier: 'cache' });
  const scope = {
    query: model.id,
    cursor: null,
    pageSize: 20,
    sort: null,
    authScope: 'anon' as const,
  };
  storage.set(SEARCH_CACHE_KEY, JSON.stringify({
    version: persistedVersion,
    entries: [{
      key: `${model.id}::__initial__::20::__default__::anon`,
      timestamp: Date.now(),
      scope,
      result: { models: [model], hasMore: false, nextCursor: null },
    }],
  }));
  storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
    version: persistedVersion,
    entries: [{
      key: `${model.id}::anon`,
      id: model.id,
      authScope: 'anon',
      timestamp: Date.now(),
      model,
    }],
  }));

  const store = new ModelCatalogCacheStore();
  return [
    store.getSearch(scope, 1000)?.models[0],
    store.getModelSnapshot(model.id, 'anon', 1000),
  ];
}

type NativeCacheMatrixCase = {
  name: string;
  model: () => ModelMetadata;
  expected: {
    chatModalities: ModelMetadata['chatModalities'];
    declaredImage: 'supported' | 'unsupported' | 'unknown';
    declaredAudio: 'supported' | 'unsupported' | 'unknown';
    projectorFileNames: string[];
    artifactRequirements: ModelArtifactRequiredInput[][];
    support: { vision: boolean; audio: boolean };
  };
};

const VIDEO_CATALOG_EVIDENCE = {
  source: 'repository_tree' as const,
  value: 'video adapter',
  confidence: 'low' as const,
};

const NATIVE_CACHE_MATRIX: NativeCacheMatrixCase[] = [
  {
    name: 'safe vision plus runtime-only audio',
    model: () => {
      const id = 'matrix/safe-vision';
      const fileName = 'mmproj-vision.gguf';
      return buildModel({
        id,
        chatModalities: ['text', 'vision', 'audio'],
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'supported', audio: 'supported', video: 'supported' },
          evidence: [
            { source: 'tag', value: 'vision', confidence: 'medium' },
            { source: 'runtime', value: 'audio', confidence: 'high' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [buildProjectorCandidate(id, 'projector-vision', fileName)],
        artifacts: [buildProjectorArtifact(id, 'projector-vision', fileName, ['image', 'audio'])],
      });
    },
    expected: {
      chatModalities: ['text', 'vision'],
      declaredImage: 'supported',
      declaredAudio: 'unknown',
      projectorFileNames: [],
      artifactRequirements: [],
      support: { vision: true, audio: false },
    },
  },
  {
    name: 'safe vision drops projector evidence tied only to an unsafe audio candidate',
    model: () => {
      const id = 'matrix/safe-vision-separate-audio-evidence';
      return buildModel({
        id,
        chatModalities: ['text', 'vision', 'audio'],
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'supported', audio: 'supported', video: 'supported' },
          evidence: [
            { source: 'tag', value: 'vision', confidence: 'medium' },
            { source: 'runtime', value: 'audio', confidence: 'high' },
            { source: 'projector', value: 'mmproj-audio.gguf', confidence: 'medium' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [
          buildProjectorCandidate(id, 'projector-vision', 'mmproj-vision.gguf'),
          buildProjectorCandidate(id, 'projector-audio', 'mmproj-audio.gguf'),
        ],
        artifacts: [
          buildProjectorArtifact(id, 'projector-vision', 'mmproj-vision.gguf', ['image']),
          buildProjectorArtifact(id, 'projector-audio', 'mmproj-audio.gguf', ['audio']),
        ],
      });
    },
    expected: {
      chatModalities: ['text', 'vision'],
      declaredImage: 'supported',
      declaredAudio: 'unknown',
      projectorFileNames: [],
      artifactRequirements: [],
      support: { vision: true, audio: false },
    },
  },
  {
    name: 'safe audio plus runtime-only vision with exact projector evidence',
    model: () => {
      const id = 'matrix/safe-audio';
      const fileName = 'mmproj-audio.gguf';
      return buildModel({
        id,
        chatModalities: ['text', 'vision', 'audio'],
        visionSource: 'runtime_probe',
        visionConfidence: 'verified',
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'supported', audio: 'supported', video: 'supported' },
          evidence: [
            { source: 'runtime', value: 'vision', confidence: 'high' },
            { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
            { source: 'projector', value: fileName, confidence: 'medium' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [buildProjectorCandidate(id, 'projector-audio', fileName)],
        artifacts: [buildProjectorArtifact(id, 'projector-audio', fileName, ['image', 'audio'])],
      });
    },
    expected: {
      chatModalities: ['text', 'audio'],
      declaredImage: 'unknown',
      declaredAudio: 'supported',
      projectorFileNames: ['mmproj-audio.gguf'],
      artifactRequirements: [['audio']],
      support: { vision: false, audio: true },
    },
  },
  {
    name: 'shared multimodal evidence remains idempotent when only audio is safe',
    model: () => {
      const id = 'matrix/shared-audio-evidence';
      const fileName = 'mmproj-audio.gguf';
      return buildModel({
        id,
        chatModalities: ['text', 'vision', 'audio'],
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'supported', audio: 'supported', video: 'supported' },
          evidence: [
            { source: 'tag', value: 'multimodal audio', confidence: 'medium' },
            { source: 'projector', value: fileName, confidence: 'medium' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [buildProjectorCandidate(id, 'projector-audio', fileName)],
        artifacts: [buildProjectorArtifact(id, 'projector-audio', fileName, ['image', 'audio'])],
      });
    },
    expected: {
      chatModalities: ['text', 'audio'],
      declaredImage: 'unknown',
      declaredAudio: 'supported',
      projectorFileNames: ['mmproj-audio.gguf'],
      artifactRequirements: [['audio']],
      support: { vision: false, audio: true },
    },
  },
  {
    name: 'both modalities backed by catalog evidence',
    model: () => {
      const id = 'matrix/safe-mixed';
      const fileName = 'mmproj-mixed.gguf';
      return buildModel({
        id,
        chatModalities: ['text', 'vision', 'audio'],
        visionSource: 'tree_probe',
        visionConfidence: 'trusted',
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'supported', audio: 'supported', video: 'supported' },
          evidence: [
            { source: 'tag', value: 'vision', confidence: 'medium' },
            { source: 'pipeline_tag', value: 'audio-text-to-text', confidence: 'high' },
            { source: 'projector', value: fileName, confidence: 'medium' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [buildProjectorCandidate(id, 'projector-mixed', fileName)],
        artifacts: [buildProjectorArtifact(id, 'projector-mixed', fileName, ['image', 'audio'])],
      });
    },
    expected: {
      chatModalities: ['text', 'vision', 'audio'],
      declaredImage: 'supported',
      declaredAudio: 'supported',
      projectorFileNames: ['mmproj-mixed.gguf'],
      artifactRequirements: [['audio', 'image']],
      support: { vision: true, audio: true },
    },
  },
  {
    name: 'stale audio evidence for a different remote projector',
    model: () => {
      const id = 'matrix/stale-projector';
      return buildModel({
        id,
        chatModalities: ['text', 'audio'],
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'unknown', audio: 'supported', video: 'supported' },
          evidence: [
            { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
            { source: 'projector', value: 'mmproj-a.gguf', confidence: 'medium' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [buildProjectorCandidate(id, 'projector-b', 'mmproj-b.gguf')],
        artifacts: [buildProjectorArtifact(id, 'projector-b', 'mmproj-b.gguf', ['audio'])],
      });
    },
    expected: {
      chatModalities: ['text'],
      declaredImage: 'unknown',
      declaredAudio: 'unknown',
      projectorFileNames: [],
      artifactRequirements: [],
      support: { vision: false, audio: false },
    },
  },
  {
    name: 'one matched audio projector plus one unmatched local candidate',
    model: () => {
      const id = 'matrix/matched-plus-local';
      return buildModel({
        id,
        chatModalities: ['text', 'audio'],
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'unknown', audio: 'supported', video: 'supported' },
          evidence: [
            { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
            { source: 'projector', value: 'mmproj-a.gguf', confidence: 'medium' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [
          buildProjectorCandidate(id, 'projector-a', 'mmproj-a.gguf'),
          buildProjectorCandidate(id, 'projector-local', 'mmproj-local.gguf', { localOnly: true }),
        ],
        artifacts: [
          buildProjectorArtifact(id, 'projector-a', 'mmproj-a.gguf', ['audio']),
          buildProjectorArtifact(id, 'projector-local', 'mmproj-local.gguf', ['audio'], { localOnly: true }),
        ],
      });
    },
    expected: {
      chatModalities: ['text', 'audio'],
      declaredImage: 'unknown',
      declaredAudio: 'supported',
      projectorFileNames: ['mmproj-a.gguf'],
      artifactRequirements: [['audio']],
      support: { vision: false, audio: true },
    },
  },
  {
    name: 'mixed model keeps separate vision and evidence-matched audio projectors',
    model: () => {
      const id = 'matrix/separate-mixed-projectors';
      return buildModel({
        id,
        chatModalities: ['text', 'vision', 'audio'],
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'supported', audio: 'supported', video: 'supported' },
          evidence: [
            { source: 'tag', value: 'vision', confidence: 'medium' },
            { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
            { source: 'projector', value: 'mmproj-audio.gguf', confidence: 'medium' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [
          buildProjectorCandidate(id, 'projector-vision', 'mmproj-vision.gguf'),
          buildProjectorCandidate(id, 'projector-audio', 'mmproj-audio.gguf'),
        ],
        artifacts: [
          buildProjectorArtifact(id, 'projector-vision', 'mmproj-vision.gguf', ['image']),
          buildProjectorArtifact(id, 'projector-audio', 'mmproj-audio.gguf', ['audio']),
        ],
      });
    },
    expected: {
      chatModalities: ['text', 'vision', 'audio'],
      declaredImage: 'supported',
      declaredAudio: 'supported',
      projectorFileNames: ['mmproj-audio.gguf'],
      artifactRequirements: [['audio']],
      support: { vision: true, audio: true },
    },
  },
  {
    name: 'vision catalog source does not retain an unrelated local-only candidate',
    model: () => {
      const id = 'matrix/vision-plus-local';
      return buildModel({
        id,
        chatModalities: ['text', 'vision'],
        visionSource: 'tree_probe',
        visionConfidence: 'trusted',
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'supported', audio: 'unknown', video: 'supported' },
          evidence: [
            { source: 'tag', value: 'vision', confidence: 'medium' },
            VIDEO_CATALOG_EVIDENCE,
          ],
        },
        projectorCandidates: [
          buildProjectorCandidate(id, 'projector-vision', 'mmproj-vision.gguf'),
          buildProjectorCandidate(id, 'projector-local', 'mmproj-local.gguf', { localOnly: true }),
        ],
        artifacts: [
          buildProjectorArtifact(id, 'projector-vision', 'mmproj-vision.gguf', ['image']),
          buildProjectorArtifact(id, 'projector-local', 'mmproj-local.gguf', ['image'], { localOnly: true }),
        ],
      });
    },
    expected: {
      chatModalities: ['text', 'vision'],
      declaredImage: 'supported',
      declaredAudio: 'unknown',
      projectorFileNames: [],
      artifactRequirements: [],
      support: { vision: true, audio: false },
    },
  },
  {
    name: 'audio declaration with absent catalog evidence',
    model: () => {
      const id = 'matrix/absent-evidence';
      const fileName = 'mmproj-absent.gguf';
      return buildModel({
        id,
        chatModalities: ['text', 'audio'],
        inputCapabilities: {
          detectedAt: 4242,
          declared: { image: 'unknown', audio: 'supported', video: 'supported' },
          evidence: [VIDEO_CATALOG_EVIDENCE],
        },
        projectorCandidates: [buildProjectorCandidate(id, 'projector-absent', fileName)],
        artifacts: [buildProjectorArtifact(id, 'projector-absent', fileName, ['audio'])],
      });
    },
    expected: {
      chatModalities: ['text'],
      declaredImage: 'unknown',
      declaredAudio: 'unknown',
      projectorFileNames: [],
      artifactRequirements: [],
      support: { vision: false, audio: false },
    },
  },
];

describe('ModelCatalogCacheStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    clearCacheStorage();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('defers persisted JSON parsing until hydration is explicitly scheduled', () => {
    const scope = { query: 'deferred', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const eagerStore = new ModelCatalogCacheStore();
    eagerStore.putSearch(scope, {
      models: [buildModel({ id: 'org/deferred-cache-model' })],
      hasMore: false,
      nextCursor: null,
    });
    const parseSpy = jest.spyOn(JSON, 'parse');

    const deferredStore = new ModelCatalogCacheStore({ hydrateOnCreate: false });

    expect(parseSpy).not.toHaveBeenCalled();
    expect(deferredStore.getSearch(scope, 1000)).toBeNull();

    deferredStore.hydrate();

    expect(parseSpy).toHaveBeenCalled();
    expect(deferredStore.getSearch(scope, 1000)?.models[0]?.id).toBe('org/deferred-cache-model');
    parseSpy.mockRestore();
  });

  it('keeps public-only and unfiltered search payloads in separate persisted scopes', () => {
    const baseScope = {
      query: 'scope-isolation',
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon' as const,
    };
    const store = new ModelCatalogCacheStore();
    store.putSearch({ ...baseScope, gated: null }, {
      models: [buildModel({ id: 'org/unfiltered-cache-model' })],
      hasMore: false,
      nextCursor: null,
    });
    store.putSearch({ ...baseScope, gated: false }, {
      models: [buildModel({ id: 'org/public-only-cache-model' })],
      hasMore: false,
      nextCursor: null,
    });

    const reloadedStore = new ModelCatalogCacheStore();

    expect(reloadedStore.getSearch({ ...baseScope, gated: null }, 1000)?.models[0]?.id)
      .toBe('org/unfiltered-cache-model');
    expect(reloadedStore.getSearch({ ...baseScope, gated: false }, 1000)?.models[0]?.id)
      .toBe('org/public-only-cache-model');
  });

  it('migrates version 7 search keys into the explicit unfiltered scope', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const scope = {
      query: 'legacy-scope',
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon' as const,
    };
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 7,
      entries: [{
        key: 'legacy-scope::__initial__::20::__default__::anon',
        timestamp: Date.now(),
        scope,
        result: {
          models: [buildModel({ id: 'org/version-seven-cache-model' })],
          hasMore: false,
          nextCursor: null,
        },
      }],
    }));

    const store = new ModelCatalogCacheStore();
    const rewrittenPayload = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string);

    expect(store.getSearch({ ...scope, gated: null }, 1000)?.models[0]?.id)
      .toBe('org/version-seven-cache-model');
    expect(rewrittenPayload.version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
    expect(rewrittenPayload.entries[0]).toEqual(expect.objectContaining({
      key: 'legacy-scope::__initial__::20::__default__::anon::gated:__any__',
      scope: expect.objectContaining({ gated: null }),
    }));
  });

  it('retries a failed hydration without retaining partially loaded entries', () => {
    const scope = { query: 'retry', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const eagerStore = new ModelCatalogCacheStore();
    eagerStore.putSearch(scope, {
      models: [buildModel({ id: 'org/partial-cache-model' })],
      hasMore: false,
      nextCursor: null,
    });
    const deferredStore = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const storage = (deferredStore as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const originalGetString = storage.getString.bind(storage);
    const getStringSpy = jest.spyOn(storage, 'getString')
      .mockImplementationOnce((key) => originalGetString(key))
      .mockImplementationOnce(() => {
        throw new Error('transient storage read failure');
      });

    expect(() => deferredStore.hydrate()).toThrow('transient storage read failure');

    storage.remove(SEARCH_CACHE_KEY);
    getStringSpy.mockImplementation((key) => originalGetString(key));
    deferredStore.hydrate();

    expect(deferredStore.getSearch(scope, 1000)).toBeNull();
    getStringSpy.mockRestore();
  });

  it('keeps deferred hydration and persistence available after a transient size probe failure', () => {
    const scope = { query: 'size-probe', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const cachedModel = buildModel({
      id: 'org/size-probe-cache-model',
      description: 'Persisted before the metrics probe',
    });
    const seedStore = new ModelCatalogCacheStore();
    seedStore.putSearch(scope, {
      models: [cachedModel],
      hasMore: false,
      nextCursor: null,
    });
    seedStore.putModelSnapshots([cachedModel], 'anon');
    const deferredStore = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const storage = (deferredStore as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const originalGetString = storage.getString.bind(storage);
    const getStringSpy = jest.spyOn(storage, 'getString')
      .mockImplementationOnce(() => {
        throw new Error('transient metrics read failure');
      })
      .mockImplementation((key) => originalGetString(key));

    expect(deferredStore.getPersistedSizeBytes()).toBe(0);
    expect(() => deferredStore.hydrate()).not.toThrow();
    expect(deferredStore.getSearch(scope, 1000)?.models[0]).toEqual(expect.objectContaining({
      id: cachedModel.id,
      description: cachedModel.description,
    }));
    expect(deferredStore.getModelSnapshot(cachedModel.id, 'anon', 1000)).toEqual(expect.objectContaining({
      id: cachedModel.id,
      description: cachedModel.description,
    }));

    const laterScope = { ...scope, query: 'size-probe-later' };
    deferredStore.putSearch(laterScope, {
      models: [buildModel({ id: 'org/persisted-after-size-probe' })],
      hasMore: false,
      nextCursor: null,
    });

    expect(createStorage(STORAGE_ID, { tier: 'cache' }).getString(SEARCH_CACHE_KEY))
      .toContain('org/persisted-after-size-probe');
    getStringSpy.mockRestore();
  });

  it('degrades to memory-only mutations when persistent hydration keeps failing', () => {
    const scope = { query: 'memory-only', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const model = buildModel({ id: 'org/memory-only-cache-model' });
    const store = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const storage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const getStringSpy = jest.spyOn(storage, 'getString').mockImplementation(() => {
      throw new Error('persistent storage unavailable');
    });

    expect(() => store.hydrate()).toThrow('persistent storage unavailable');
    expect(() => store.putSearch(scope, {
      models: [model],
      hasMore: false,
      nextCursor: null,
    })).not.toThrow();
    expect(() => store.putModelSnapshots([model], 'anon')).not.toThrow();

    expect(store.getSearch(scope, 1000)?.models[0]?.id).toBe(model.id);
    expect(store.getModelSnapshot(model.id, 'anon', 1000)?.id).toBe(model.id);
    expect(getStringSpy).toHaveBeenCalledTimes(2);
    getStringSpy.mockRestore();
  });

  it('keeps cache writes in memory when persistence writes fail', () => {
    const scope = { query: 'write-failure', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const model = buildModel({ id: 'org/write-failure-cache-model' });
    const store = new ModelCatalogCacheStore();
    const storage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const setSpy = jest.spyOn(storage, 'set').mockImplementation(() => {
      throw new Error('persistent storage write failure');
    });

    expect(() => store.putSearch(scope, {
      models: [model],
      hasMore: false,
      nextCursor: null,
    })).not.toThrow();
    expect(() => store.putSearch({ ...scope, query: 'second-write' }, {
      models: [model],
      hasMore: false,
      nextCursor: null,
    })).not.toThrow();

    expect(store.getSearch(scope, 1000)?.models[0]?.id).toBe(model.id);
    expect(setSpy).toHaveBeenCalledTimes(1);
    setSpy.mockRestore();
  });

  it('removes a stale anonymous payload when a reconciliation write fails', () => {
    const scope = { query: 'visibility-write-failure', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const safeModel = buildModel({ id: 'org/still-public' });
    const staleModel = buildModel({ id: 'org/became-private' });
    const seedStore = new ModelCatalogCacheStore();
    seedStore.putSearch(scope, {
      models: [safeModel, staleModel],
      hasMore: false,
      nextCursor: null,
    });
    const store = new ModelCatalogCacheStore();
    const storage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const setSpy = jest.spyOn(storage, 'set').mockImplementation(() => {
      throw new Error('persistent storage write failure');
    });
    const removeSpy = jest.spyOn(storage, 'remove');

    expect(() => store.reconcileAnonymousSearchModels([{
      ...staleModel,
      accessState: ModelAccessState.AUTHORIZED,
      isPrivate: true,
    }])).not.toThrow();

    expect(store.getSearch(scope, 1000)?.models.map((model) => model.id)).toEqual([safeModel.id]);
    expect(removeSpy).toHaveBeenCalledWith(SEARCH_CACHE_KEY);
    expect(createStorage(STORAGE_ID, { tier: 'cache' }).getString(SEARCH_CACHE_KEY)).toBeUndefined();
    expect(new ModelCatalogCacheStore().getSearch(scope, 1000)).toBeNull();

    removeSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('keeps reconciliation memory state fail-open when stale-payload invalidation also fails', () => {
    const scope = { query: 'visibility-remove-failure', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const safeModel = buildModel({ id: 'org/still-public-after-remove-failure' });
    const staleModel = buildModel({ id: 'org/private-after-remove-failure' });
    const seedStore = new ModelCatalogCacheStore();
    seedStore.putSearch(scope, {
      models: [safeModel, staleModel],
      hasMore: false,
      nextCursor: null,
    });
    const persistedBeforeFailure = createStorage(STORAGE_ID, { tier: 'cache' }).getString(SEARCH_CACHE_KEY);
    const store = new ModelCatalogCacheStore();
    const storage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const setSpy = jest.spyOn(storage, 'set').mockImplementation(() => {
      throw new Error('persistent storage write failure');
    });
    const removeSpy = jest.spyOn(storage, 'remove').mockImplementation(() => {
      throw new Error('persistent storage remove failure');
    });

    expect(() => store.reconcileAnonymousSearchModels([{
      ...staleModel,
      accessState: ModelAccessState.AUTHORIZED,
      isPrivate: true,
    }])).not.toThrow();
    expect(store.getSearch(scope, 1000)?.models.map((model) => model.id)).toEqual([safeModel.id]);
    expect(createStorage(STORAGE_ID, { tier: 'cache' }).getString(SEARCH_CACHE_KEY)).toBe(persistedBeforeFailure);
    expect(() => store.putSearch({ ...scope, query: 'later-memory-only-write' }, {
      models: [safeModel],
      hasMore: false,
      nextCursor: null,
    })).not.toThrow();
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    removeSpy.mockRestore();
    setSpy.mockRestore();
  });

  it('drops oversized persisted payloads before JSON parsing', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    storage.set(
      SEARCH_CACHE_KEY,
      `{"version":${MODEL_CATALOG_CACHE_PERSISTED_VERSION},"entries":[],"padding":"${'x'.repeat(
        MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES,
      )}"}`,
    );
    const store = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const storeStorage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const parseSpy = jest.spyOn(JSON, 'parse');
    const trimSpy = jest.spyOn(storeStorage, 'trim');

    store.hydrate();

    expect(parseSpy).not.toHaveBeenCalled();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();
    expect(trimSpy).toHaveBeenCalledTimes(1);
    trimSpy.mockRestore();
    parseSpy.mockRestore();
  });

  it('hydrates persisted models incrementally and shares one in-flight attempt', async () => {
    const scope = { query: 'incremental', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const eagerStore = new ModelCatalogCacheStore();
    eagerStore.putSearch(scope, {
      models: [
        buildModel({ id: 'org/incremental-a' }),
        buildModel({ id: 'org/incremental-b' }),
        buildModel({ id: 'org/incremental-c' }),
        buildModel({ id: 'org/incremental-d' }),
        buildModel({ id: 'org/incremental-e' }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    const deferredStore = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const immediateSpy = jest.spyOn(globalThis, 'setImmediate');

    const firstAttempt = deferredStore.hydrateIncrementally();
    const sharedAttempt = deferredStore.hydrateIncrementally();

    expect(sharedAttempt).toBe(firstAttempt);
    expect(deferredStore.getSearch(scope, 1000)).toBeNull();
    await jest.runAllTimersAsync();
    await firstAttempt;

    expect(immediateSpy).toHaveBeenCalled();
    expect(deferredStore.getSearch(scope, 1000)?.models.map((model) => model.id)).toEqual([
      'org/incremental-a',
      'org/incremental-b',
      'org/incremental-c',
      'org/incremental-d',
      'org/incremental-e',
    ]);
    immediateSpy.mockRestore();
  });

  it('does not restore a payload that was cleared while incremental hydration was yielding', async () => {
    const scope = { query: 'clear-during-hydration', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const eagerStore = new ModelCatalogCacheStore();
    eagerStore.putSearch(scope, {
      models: [
        buildModel({ id: 'org/clear-a' }),
        buildModel({ id: 'org/clear-b' }),
        buildModel({ id: 'org/clear-c' }),
        buildModel({ id: 'org/clear-d' }),
        buildModel({ id: 'org/clear-e' }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const persistedPayload = storage.getString(SEARCH_CACHE_KEY);
    expect(persistedPayload).toBeDefined();
    storage.set(
      SEARCH_CACHE_KEY,
      persistedPayload!
        .replace(`"version":${MODEL_CATALOG_CACHE_PERSISTED_VERSION}`, '"version":7')
        .replace(',"sanitized":true', ''),
    );
    const deferredStore = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const freshScope = { ...scope, query: 'fresh-after-clear' };

    const hydrationAttempt = deferredStore.hydrateIncrementally();
    deferredStore.clearAll();
    deferredStore.putSearch(freshScope, {
      models: [buildModel({ id: 'org/fresh-after-clear' })],
      hasMore: false,
      nextCursor: null,
    });
    await jest.runAllTimersAsync();
    await hydrationAttempt;

    expect(deferredStore.getSearch(scope, 1000)).toBeNull();
    expect(deferredStore.getSearch(freshScope, 1000)?.models.map((model) => model.id)).toEqual([
      'org/fresh-after-clear',
    ]);
    expect(storage.getString(SEARCH_CACHE_KEY)).toContain('org/fresh-after-clear');
    expect(storage.getString(SEARCH_CACHE_KEY)).not.toContain('org/clear-a');
  });

  it('does not overwrite a fresh mutation with an older incremental payload', async () => {
    const scope = { query: 'mutation-during-hydration', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const eagerStore = new ModelCatalogCacheStore();
    eagerStore.putSearch(scope, {
      models: [
        buildModel({ id: 'org/stale-a' }),
        buildModel({ id: 'org/stale-b' }),
        buildModel({ id: 'org/stale-c' }),
        buildModel({ id: 'org/stale-d' }),
        buildModel({ id: 'org/stale-e' }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    const deferredStore = new ModelCatalogCacheStore({ hydrateOnCreate: false });

    const hydrationAttempt = deferredStore.hydrateIncrementally();
    deferredStore.putSearch(scope, {
      models: [buildModel({ id: 'org/fresh-mutation' })],
      hasMore: false,
      nextCursor: null,
    });
    await jest.runAllTimersAsync();
    await hydrationAttempt;

    expect(deferredStore.getSearch(scope, 1000)?.models.map((model) => model.id)).toEqual([
      'org/fresh-mutation',
    ]);
    expect(createStorage(STORAGE_ID, { tier: 'cache' }).getString(SEARCH_CACHE_KEY)).toContain(
      'org/fresh-mutation',
    );
  });

  it('does not restore snapshots cleared during incremental hydration', async () => {
    const staleModels = ['a', 'b', 'c', 'd', 'e'].map((suffix) => (
      buildModel({ id: `org/stale-snapshot-${suffix}` })
    ));
    const eagerStore = new ModelCatalogCacheStore();
    eagerStore.putModelSnapshots(staleModels, 'anon');
    const deferredStore = new ModelCatalogCacheStore({ hydrateOnCreate: false });

    const hydrationAttempt = deferredStore.hydrateIncrementally();
    deferredStore.clearSnapshots();
    await jest.runAllTimersAsync();
    await hydrationAttempt;

    staleModels.forEach((model) => {
      expect(deferredStore.getModelSnapshot(model.id, 'anon', 1000)).toBeNull();
    });
    expect(createStorage(STORAGE_ID, { tier: 'cache' }).getString(SNAPSHOT_CACHE_KEY)).toBeUndefined();
  });

  it.each([8, 9])('drops retired v%s payloads before JSON parsing', (retiredVersion) => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    storage.set(SEARCH_CACHE_KEY, `{"version":${retiredVersion},"entries":[]}`);
    const store = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const storeStorage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const parseSpy = jest.spyOn(JSON, 'parse');
    const trimSpy = jest.spyOn(storeStorage, 'trim');

    store.hydrate();

    expect(parseSpy).not.toHaveBeenCalled();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();
    expect(trimSpy).toHaveBeenCalledTimes(1);
    trimSpy.mockRestore();
    parseSpy.mockRestore();
  });

  it('keeps retired-payload hydration fail-open when MMKV compaction fails', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    storage.set(SEARCH_CACHE_KEY, '{"version":9,"entries":[]}');
    const store = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const storeStorage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const trimSpy = jest.spyOn(storeStorage, 'trim').mockImplementation(() => {
      throw new Error('trim failed');
    });

    expect(() => store.hydrate()).not.toThrow();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();
    expect(storage.getNumber(CACHE_MAINTENANCE_VERSION_KEY)).toBeUndefined();
    expect(trimSpy).toHaveBeenCalledTimes(1);
    trimSpy.mockRestore();
  });

  it('does not compact an already maintained current bounded payload during hydration', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    storage.set(CACHE_MAINTENANCE_VERSION_KEY, 1);
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: MODEL_CATALOG_CACHE_PERSISTED_VERSION,
      sanitized: true,
      entries: [],
    }));
    const store = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const storeStorage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const trimSpy = jest.spyOn(storeStorage, 'trim');

    store.hydrate();

    expect(trimSpy).not.toHaveBeenCalled();
    trimSpy.mockRestore();
  });

  it('compacts an oversized keyless MMKV file left by an earlier migration', () => {
    const store = new ModelCatalogCacheStore({ hydrateOnCreate: false });
    const storeStorage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    Object.defineProperty(storeStorage, 'byteSize', {
      configurable: true,
      value: MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES + 1,
    });
    const trimSpy = jest.spyOn(storeStorage, 'trim');

    store.hydrate();

    expect(trimSpy).toHaveBeenCalledTimes(1);
    expect(createStorage(STORAGE_ID, { tier: 'cache' }).getNumber(CACHE_MAINTENANCE_VERSION_KEY)).toBe(1);
    trimSpy.mockRestore();
  });

  it('fails closed when a marked current payload is no longer anonymous-public', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'org/marked-private-model';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const unsafeModel = buildModel({
      id,
      accessState: ModelAccessState.AUTHORIZED,
      isPrivate: true,
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: MODEL_CATALOG_CACHE_PERSISTED_VERSION,
      sanitized: true,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`,
        timestamp: Date.now(),
        scope,
        result: { models: [unsafeModel], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: MODEL_CATALOG_CACHE_PERSISTED_VERSION,
      sanitized: true,
      entries: [{
        key: `${id}::anon`,
        id,
        authScope: 'anon',
        timestamp: Date.now(),
        model: unsafeModel,
      }],
    }));

    const store = new ModelCatalogCacheStore();

    expect(store.getSearch(scope, 1000)).toBeNull();
    expect(store.getModelSnapshot(id, 'anon', 1000)).toBeNull();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBeUndefined();
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBeUndefined();
  });

  it('bounds persisted payload bytes without evicting smaller recent entries from memory', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const store = new ModelCatalogCacheStore();
    const smallScope = { query: 'small', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const largeScope = { query: 'large', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    store.putSearch(smallScope, {
      models: [buildModel({ id: 'org/small-cache-model' })],
      hasMore: false,
      nextCursor: null,
    });

    store.putSearch(largeScope, {
      models: [buildModel({
        id: 'org/oversized-cache-model',
        description: 'x'.repeat(MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES),
      })],
      hasMore: false,
      nextCursor: null,
    });

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MODEL_CATALOG_CACHE_MAX_PAYLOAD_BYTES);
    expect(raw).toContain('org/small-cache-model');
    expect(raw).not.toContain('org/oversized-cache-model');
    expect(store.getSearch(largeScope, 1000)?.models[0]?.id).toBe('org/oversized-cache-model');
  });

  it('persists a compact GGUF digest instead of raw tokenizer metadata', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const store = new ModelCatalogCacheStore();
    const scope = { query: 'compact-gguf', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const model = buildModel({
      id: 'org/compact-gguf-model',
      gguf: {
        architecture: 'qwen3',
        sizeLabel: 'Q4_K_M',
        totalBytes: 1024,
        contextLengthTokens: 32_768,
        'general.architecture': 'qwen3',
        'general.type': 'model',
        'qwen3.block_count': 36,
        'tokenizer.chat_template': 'large-template-that-must-not-reach-startup-storage',
        'tokenizer.ggml.model': 'gpt2',
      },
    });

    store.putSearch(scope, { models: [model], hasMore: false, nextCursor: null });

    const raw = storage.getString(SEARCH_CACHE_KEY) as string;
    const persistedModel = JSON.parse(raw).entries[0].result.models[0] as ModelMetadata;
    expect(persistedModel.gguf).toEqual({
      architecture: 'qwen3',
      sizeLabel: 'Q4_K_M',
      totalBytes: 1024,
      contextLengthTokens: 32_768,
      'general.architecture': 'qwen3',
      'general.type': 'model',
      'qwen3.block_count': 36,
    });
    expect(raw).not.toContain('large-template-that-must-not-reach-startup-storage');
    expect(raw).not.toContain('tokenizer.ggml.model');
    expect(new ModelCatalogCacheStore().getSearch(scope, 1000)?.models[0]?.gguf)
      .toEqual(persistedModel.gguf);
  });

  it('preserves an explicit empty projector result across search and snapshot cache round-trips', () => {
    const model = buildModel({
      id: 'org/authoritative-empty-projectors',
      projectorCandidates: [],
    });
    const scope = { query: model.id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const store = new ModelCatalogCacheStore();
    store.putSearch(scope, { models: [model], hasMore: false, nextCursor: null });
    store.putModelSnapshots([model], 'anon');

    const reloadedStore = new ModelCatalogCacheStore();

    expect(reloadedStore.getSearch(scope, 1000)?.models[0]?.projectorCandidates).toEqual([]);
    expect(reloadedStore.getModelSnapshot(model.id, 'anon', 1000)?.projectorCandidates).toEqual([]);
  });

  it.each(NATIVE_CACHE_MATRIX)(
    'enforces native cache state matrix: $name',
    ({ model: makeModel, expected }) => {
      const sourceModel = makeModel();
      const scope = {
        query: sourceModel.id,
        cursor: null,
        pageSize: 20,
        sort: null,
        authScope: 'anon' as const,
      };
      const directModel = sanitizeCatalogModelRuntimeState(sourceModel);
      expect(sanitizeCatalogModelRuntimeState(directModel)).toEqual(directModel);
      const store = new ModelCatalogCacheStore();
      store.putSearch(scope, { models: [sourceModel], hasMore: false, nextCursor: null });
      store.putModelSnapshots([sourceModel], 'anon');
      const reloadedStore = new ModelCatalogCacheStore();
      const searchModel = reloadedStore.getSearch(scope, 1000)?.models[0];
      const snapshotModel = reloadedStore.getModelSnapshot(sourceModel.id, 'anon', 1000);

      for (const cachedModel of [directModel, searchModel, snapshotModel]) {
        expect(cachedModel).toBeDefined();
        expect(cachedModel?.chatModalities).toEqual(expected.chatModalities);
        expect(cachedModel?.inputCapabilities?.detectedAt).toBe(4242);
        expect(cachedModel?.inputCapabilities?.declared).toEqual({
          image: expected.declaredImage,
          audio: expected.declaredAudio,
          video: 'supported',
        });
        expect(cachedModel?.inputCapabilities?.evidence.some((entry) => entry.source === 'runtime')).toBe(false);
        expect(cachedModel?.inputCapabilities?.evidence.some((entry) => (
          inputCapabilityEvidenceSupportsModality(entry, 'image')
        )) ?? false).toBe(expected.declaredImage === 'supported');
        expect(cachedModel?.inputCapabilities?.evidence.some((entry) => (
          inputCapabilityEvidenceSupportsModality(entry, 'audio')
        )) ?? false).toBe(expected.declaredAudio === 'supported');
        expect(cachedModel?.inputCapabilities?.evidence).toContainEqual(VIDEO_CATALOG_EVIDENCE);
        expect(cachedModel?.projectorCandidates?.map((candidate) => candidate.fileName) ?? [])
          .toEqual(expected.projectorFileNames);
        expect(cachedModel?.projectorCandidates?.some((candidate) => candidate.localPath !== undefined) ?? false)
          .toBe(false);
        expect(cachedModel?.artifacts
          ?.filter((artifact) => artifact.kind === 'multimodal_projector')
          .map((artifact) => artifact.requiredFor) ?? []).toEqual(expected.artifactRequirements);
        expect(cachedModel?.selectedProjectorId).toBeUndefined();
        expect(cachedModel?.multimodalReadiness).toBeUndefined();
        expect(resolveModelNativeMultimodalSupport(cachedModel as ModelMetadata)).toEqual(expected.support);

        const composerCapabilities = resolveEffectiveInputCapabilities({
          model: cachedModel,
          engineState: {
            status: EngineStatus.READY,
            activeModelId: cachedModel?.id,
            loadProgress: 1,
          },
        });
        expect({ image: composerCapabilities.image, audio: composerCapabilities.audio })
          .toEqual({ image: false, audio: false });
      }
    },
  );

  it('keeps only the exact full-path projector when two candidates share a basename', () => {
    const id = 'identity/same-basename';
    const audio = buildProjectorCandidate(id, 'audio-projector', 'audio/mmproj.gguf');
    const vision = buildProjectorCandidate(id, 'vision-projector', 'vision/mmproj.gguf');
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: audio.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [audio, vision],
      artifacts: [
        buildProjectorArtifact(id, audio.id, audio.fileName, ['audio']),
        buildProjectorArtifact(id, vision.id, vision.fileName, ['audio']),
      ],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.projectorCandidates?.map((candidate) => candidate.fileName)).toEqual([audio.fileName]);
      expect(cached.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({
          id: getCurrentProjectorId(audio),
          remoteFileName: audio.fileName,
        })]);
    }
  });

  it('keeps case-distinct projector paths separate in current cache payloads', () => {
    const id = 'identity/case-distinct';
    const upper = buildProjectorCandidate(id, 'upper-projector', 'Adapters/MMProj.GGUF');
    const lower = buildProjectorCandidate(id, 'lower-projector', 'Adapters/mmproj.gguf');
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: upper.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [upper, lower],
      artifacts: [
        buildProjectorArtifact(id, upper.id, upper.fileName, ['audio']),
        buildProjectorArtifact(id, lower.id, lower.fileName, ['audio']),
      ],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.projectorCandidates?.map((candidate) => candidate.fileName)).toEqual([upper.fileName]);
      expect(cached.inputCapabilities?.evidence).toContainEqual(
        expect.objectContaining({ source: 'projector', value: upper.fileName }),
      );
    }
  });

  it.each(['lower-first', 'upper-first'] as const)(
    'keeps an exact current artifact when its id also equals a colliding legacy alias (%s)',
    (candidateOrder) => {
      const id = 'identity/current-id-before-legacy';
      const lowerIdentity = {
        repoId: id,
        hfRevision: 'main',
        fileName: 'projectors/mmproj.gguf',
      };
      const upperIdentity = {
        repoId: id,
        hfRevision: 'main',
        fileName: 'projectors/MMProj.gguf',
      };
      const lower = buildProjectorCandidate(
        id,
        buildProjectorArtifactId(lowerIdentity),
        lowerIdentity.fileName,
      );
      const upper = buildProjectorCandidate(
        id,
        buildProjectorArtifactId(upperIdentity),
        upperIdentity.fileName,
      );
      expect(lower.id).not.toBe(upper.id);
      expect(lower.id).toBe(buildLegacyProjectorArtifactId(lowerIdentity));
      expect(lower.id).toBe(buildLegacyProjectorArtifactId(upperIdentity));

      const model = buildModel({
        id,
        chatModalities: ['text', 'audio'],
        inputCapabilities: {
          detectedAt: 1,
          declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
          evidence: [
            { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
            { source: 'projector', value: lower.fileName, confidence: 'medium' },
          ],
        },
        projectorCandidates: candidateOrder === 'lower-first' ? [lower, upper] : [upper, lower],
        artifacts: [buildProjectorArtifact(id, lower.id, lower.fileName, ['audio'])],
      });

      for (const cached of roundTripAnonymousModel(model)) {
        expect(cached.projectorCandidates).toEqual([
          expect.objectContaining({ id: lower.id, fileName: lower.fileName }),
        ]);
        expect(cached.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
          .toEqual([expect.objectContaining({
            id: lower.id,
            remoteFileName: lower.fileName,
            requiredFor: ['audio'],
          })]);
        expect(cached.inputCapabilities?.evidence).toContainEqual(
          expect.objectContaining({ source: 'projector', value: lower.fileName }),
        );
      }
    },
  );

  it('fails closed for ambiguous legacy v6 basename evidence in search and snapshot payloads', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'identity/legacy-ambiguous';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'mmproj.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [
        buildProjectorCandidate(id, 'audio-projector', 'audio/mmproj.gguf'),
        buildProjectorCandidate(id, 'vision-projector', 'vision/mmproj.gguf'),
      ],
    });
    const searchEntry = {
      key: `${id}::__initial__::20::__default__::anon`,
      timestamp: Date.now(),
      scope,
      result: { models: [model], hasMore: false, nextCursor: null },
    };
    const snapshotEntry = {
      key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model,
    };
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({ version: 6, entries: [searchEntry] }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({ version: 6, entries: [snapshotEntry] }));

    const store = new ModelCatalogCacheStore();
    expect(store.getSearch(scope, 1000)?.models[0]?.projectorCandidates).toBeUndefined();
    expect(store.getModelSnapshot(id, 'anon', 1000)?.projectorCandidates).toBeUndefined();
    expect(JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string).version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
    expect(JSON.parse(storage.getString(SNAPSHOT_CACHE_KEY) as string).version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
  });

  it('fails closed for case-distinct identities behind one folded legacy full path', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'identity/legacy-case-ambiguous';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'adapters/mmproj.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [
        buildProjectorCandidate(id, 'upper-projector', 'Adapters/MMProj.GGUF'),
        buildProjectorCandidate(id, 'lower-projector', 'Adapters/mmproj.gguf'),
      ],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`, timestamp: Date.now(), scope,
        result: { models: [model], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{ key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model }],
    }));

    const store = new ModelCatalogCacheStore();
    expect(store.getSearch(scope, 1000)?.models[0]?.projectorCandidates).toBeUndefined();
    expect(store.getModelSnapshot(id, 'anon', 1000)?.projectorCandidates).toBeUndefined();
  });

  it('migrates a unique folded legacy full path to its exact remote identity', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'identity/legacy-full-path-unique';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const projector = buildProjectorCandidate(id, 'audio-projector', 'Nested/Audio/MMProj.GGUF');
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'nested\\audio\\mmproj.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`, timestamp: Date.now(), scope,
        result: { models: [model], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{ key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model }],
    }));

    const store = new ModelCatalogCacheStore();
    for (const cached of [
      store.getSearch(scope, 1000)?.models[0],
      store.getModelSnapshot(id, 'anon', 1000),
    ]) {
      expect(cached?.projectorCandidates?.[0]?.fileName).toBe(projector.fileName);
      expect(cached?.inputCapabilities?.evidence).toContainEqual(
        expect.objectContaining({ source: 'projector', value: projector.fileName }),
      );
    }
  });

  it('migrates a unique legacy v6 basename to its exact full path in both payloads', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'identity/legacy-unique';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const projector = buildProjectorCandidate(id, 'audio-projector', 'nested/Audio/MMProj.GGUF');
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'mmproj.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [buildProjectorArtifact(id, projector.id, projector.fileName, ['audio'])],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`,
        timestamp: Date.now(), scope, result: { models: [model], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{ key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model }],
    }));

    const store = new ModelCatalogCacheStore();
    for (const cached of [
      store.getSearch(scope, 1000)?.models[0],
      store.getModelSnapshot(id, 'anon', 1000),
    ]) {
      expect(cached?.projectorCandidates?.[0]?.fileName).toBe(projector.fileName);
      expect(cached?.inputCapabilities?.evidence).toContainEqual(
        expect.objectContaining({ source: 'projector', value: projector.fileName }),
      );
    }
    expect(storage.getString(SEARCH_CACHE_KEY)).toContain(projector.fileName);
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toContain(projector.fileName);
  });

  it.each([
    { label: 'another repository', repoId: 'other/projectors', revision: 'main' },
    { label: 'another revision', repoId: 'identity/evidence-owner', revision: 'dev' },
  ])('rejects internally consistent projector evidence from $label', ({ repoId, revision }) => {
    const id = 'identity/evidence-owner';
    const fileName = 'audio/mmproj.gguf';
    const projector = buildProjectorCandidate(id, `projector-${revision}`, fileName, {
      repoId,
      revision,
    });
    const model = buildModel({
      id,
      hfRevision: 'main',
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [buildProjectorArtifact(id, projector.id, fileName, ['audio'], {
        repoId,
        revision,
      })],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.chatModalities).toEqual(['text']);
      expect(cached.projectorCandidates).toBeUndefined();
      expect(cached.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector') ?? false)
        .toBe(false);
      expect(cached.inputCapabilities?.evidence.some((entry) => entry.source === 'projector') ?? false)
        .toBe(false);
    }
  });

  it('retains only exact owner-repository and owner-revision evidence with a current id', () => {
    const id = 'identity/evidence-exact';
    const fileName = 'Audio/MMProj.GGUF';
    const projector = buildProjectorCandidate(id, 'catalog-projector', fileName, {
      revision: 'refs/pr/7',
    });
    const currentId = getCurrentProjectorId(projector);
    const model = buildModel({
      id,
      hfRevision: 'refs/pr/7',
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [buildProjectorArtifact(id, projector.id, fileName, ['audio'], {
        revision: 'refs/pr/7',
      })],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.chatModalities).toEqual(['text', 'audio']);
      expect(cached.projectorCandidates).toEqual([
        expect.objectContaining({ id: currentId, fileName, hfRevision: 'refs/pr/7' }),
      ]);
      expect(cached.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({ id: currentId, remoteFileName: fileName })]);
      expect(cached.inputCapabilities?.evidence).toContainEqual(
        expect.objectContaining({ source: 'projector', value: fileName }),
      );
    }
  });

  it('fails closed when legacy basename evidence spans two revisions of the owning repository', () => {
    const id = 'identity/legacy-revision-ambiguity';
    const fileName = 'projectors/mmproj.gguf';
    const main = buildProjectorCandidate(id, 'projector-main', fileName, { revision: 'main' });
    const dev = buildProjectorCandidate(id, 'projector-dev', fileName, { revision: 'dev' });
    const model = buildModel({
      id,
      hfRevision: 'main',
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'mmproj.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [main, dev],
      artifacts: [
        buildProjectorArtifact(id, main.id, fileName, ['audio'], { revision: 'main' }),
        buildProjectorArtifact(id, dev.id, fileName, ['audio'], { revision: 'dev' }),
      ],
    });

    for (const cached of hydrateLegacyAnonymousModel(model, 6)) {
      expect(cached?.chatModalities).toEqual(['text']);
      expect(cached?.projectorCandidates).toBeUndefined();
      expect(cached?.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector') ?? false)
        .toBe(false);
    }
  });

  it('does not let a cross-repository basename make unique legacy owner evidence ambiguous', () => {
    const id = 'identity/legacy-cross-repo';
    const fileName = 'nested/mmproj.gguf';
    const owned = buildProjectorCandidate(id, 'owned-projector', fileName);
    const foreign = buildProjectorCandidate(id, 'foreign-projector', fileName, {
      repoId: 'other/projectors',
    });
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'mmproj.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [foreign, owned],
      artifacts: [
        buildProjectorArtifact(id, foreign.id, fileName, ['audio'], { repoId: 'other/projectors' }),
        buildProjectorArtifact(id, owned.id, fileName, ['audio']),
      ],
    });

    for (const cached of hydrateLegacyAnonymousModel(model, 6)) {
      expect(cached?.projectorCandidates).toEqual([
        expect.objectContaining({ id: getCurrentProjectorId(owned), fileName }),
      ]);
      expect(cached?.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({ id: getCurrentProjectorId(owned) })]);
    }
  });

  it.each([
    {
      label: 'file path',
      mutate: (projector: NonNullable<ModelMetadata['projectorCandidates']>[number]) => {
        projector.fileName = 'audio/mmproj.gguf';
      },
    },
    {
      label: 'repository',
      mutate: (projector: NonNullable<ModelMetadata['projectorCandidates']>[number]) => {
        projector.repoId = 'other/model';
      },
    },
    {
      label: 'revision',
      mutate: (projector: NonNullable<ModelMetadata['projectorCandidates']>[number]) => {
        projector.hfRevision = 'dev';
      },
    },
    {
      label: 'host',
      mutate: (projector: NonNullable<ModelMetadata['projectorCandidates']>[number]) => {
        projector.downloadUrl = projector.downloadUrl.replace('huggingface.co', 'example.com');
      },
    },
    {
      label: 'malformed URL',
      mutate: (projector: NonNullable<ModelMetadata['projectorCandidates']>[number]) => {
        projector.downloadUrl = 'not-a-url';
      },
    },
  ])('drops a candidate whose $label disagrees with its remote identity', ({ label, mutate }) => {
    const id = `identity/candidate-${label.replace(/\s+/gu, '-')}-mismatch`;
    const projector = buildProjectorCandidate(id, 'mismatched-projector', 'vision/mmproj.gguf');
    mutate(projector);
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: projector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [buildProjectorArtifact(id, projector.id, projector.fileName, ['audio'])],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.projectorCandidates).toBeUndefined();
      expect(cached.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector') ?? false)
        .toBe(false);
    }
  });

  it('drops a same-id artifact when its remote URL identifies another path', () => {
    const id = 'identity/artifact-url-mismatch';
    const projector = buildProjectorCandidate(id, 'audio-projector', 'audio/mmproj.gguf');
    const staleArtifact = buildProjectorArtifact(id, projector.id, 'stale/mmproj.gguf', ['audio']);
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: projector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [staleArtifact],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.projectorCandidates).toBeUndefined();
      expect(cached.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector') ?? false)
        .toBe(false);
    }
  });

  it('drops a legacy-id candidate when its derived-current-id artifact identifies another path', () => {
    const id = 'identity/legacy-current-artifact-conflict';
    const identity = {
      repoId: id,
      hfRevision: 'main',
      fileName: 'Audio/MMProj.GGUF',
    };
    const currentId = buildProjectorArtifactId(identity);
    const legacyId = buildLegacyProjectorArtifactId(identity);
    expect(currentId).not.toBe(legacyId);
    const projector = buildProjectorCandidate(id, legacyId, identity.fileName);
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: projector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [buildProjectorArtifact(id, currentId, 'Stale/MMProj.GGUF', ['audio'])],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.projectorCandidates).toBeUndefined();
      expect(cached.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector') ?? false)
        .toBe(false);
      expect(cached.inputCapabilities?.evidence.some((entry) => entry.source === 'projector') ?? false)
        .toBe(false);
    }
  });

  it('does not let a safe model candidate authorize a poisoned variant candidate with the same remote identity', () => {
    const id = 'identity/candidate-scope-independence';
    const fileName = 'shared/MMProj.GGUF';
    const modelProjector = buildProjectorCandidate(id, 'model-projector', fileName);
    const variantProjector = {
      ...buildProjectorCandidate(id, 'variant-projector', fileName),
      ownerVariantId: 'variant-b',
    };
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [modelProjector],
      variants: [{
        variantId: 'variant-b',
        fileName: 'model-b.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [variantProjector],
      }],
      artifacts: [
        buildProjectorArtifact(id, modelProjector.id, fileName, ['audio']),
        buildProjectorArtifact(id, variantProjector.id, 'stale/MMProj.GGUF', ['audio']),
      ],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.projectorCandidates).toEqual([
        expect.objectContaining({ id: getCurrentProjectorId(modelProjector), fileName }),
      ]);
      expect(cached.variants?.[0]?.projectorCandidates).toBeUndefined();
      expect(cached.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({
          id: getCurrentProjectorId(modelProjector),
          remoteFileName: fileName,
        })]);
    }
  });

  it('sees a raw canonically-equal artifact id collision before legacy normalization can hide it', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'identity/raw-artifact-id-collision';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const projector = buildProjectorCandidate(id, ' audio-projector ', 'audio/mmproj.gguf');
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: projector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [
        buildProjectorArtifact(id, projector.id, projector.fileName, ['audio']),
        buildProjectorArtifact(id, projector.id.trim(), 'stale/mmproj.gguf', ['audio']),
      ],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`, timestamp: Date.now(), scope,
        result: { models: [model], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{ key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model }],
    }));

    const store = new ModelCatalogCacheStore();
    expect(store.getSearch(scope, 1000)?.models[0]?.projectorCandidates).toEqual([]);
    expect(store.getModelSnapshot(id, 'anon', 1000)?.projectorCandidates).toEqual([]);
  });

  it('drops raw duplicate artifacts with order-dependent projector requirements', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'identity/raw-artifact-requirement-collision';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const projector = buildProjectorCandidate(id, 'shared-projector', 'shared/mmproj.gguf');
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: projector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [
        buildProjectorArtifact(id, projector.id, projector.fileName, ['audio']),
        buildProjectorArtifact(id, projector.id, projector.fileName, ['image']),
      ],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`, timestamp: Date.now(), scope,
        result: { models: [model], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{ key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model }],
    }));

    const store = new ModelCatalogCacheStore();
    expect(store.getSearch(scope, 1000)?.models[0]?.projectorCandidates).toEqual([]);
    expect(store.getModelSnapshot(id, 'anon', 1000)?.projectorCandidates).toEqual([]);
  });

  it.each(['current-first', 'legacy-first'] as const)(
    'fails closed for divergent current and legacy projector requirements (%s)',
    (artifactOrder) => {
      const storage = createStorage(STORAGE_ID, { tier: 'cache' });
      const id = `identity/raw-alias-requirement-${artifactOrder}`;
      const fileName = 'shared/mmproj.gguf';
      const identity = { repoId: id, hfRevision: 'main', fileName };
      const projector = buildProjectorCandidate(
        id,
        buildProjectorArtifactId(identity),
        fileName,
      );
      const currentArtifact = buildProjectorArtifact(id, projector.id, fileName, ['image']);
      const legacyArtifact = buildProjectorArtifact(
        id,
        buildLegacyProjectorArtifactId(identity),
        fileName,
        ['audio'],
      );
      const model = buildModel({
        id,
        chatModalities: ['text', 'vision', 'audio'],
        visionSource: 'catalog_metadata',
        visionConfidence: 'trusted',
        inputCapabilities: {
          detectedAt: 1,
          declared: { image: 'supported', audio: 'supported', video: 'unknown' },
          evidence: [
            { source: 'tag', value: 'vision', confidence: 'medium' },
            { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
            { source: 'projector', value: fileName, confidence: 'medium' },
          ],
        },
        projectorCandidates: [projector],
        artifacts: artifactOrder === 'current-first'
          ? [currentArtifact, legacyArtifact]
          : [legacyArtifact, currentArtifact],
      });
      const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
      storage.set(SEARCH_CACHE_KEY, JSON.stringify({
        version: 6,
        entries: [{
          key: `${id}::__initial__::20::__default__::anon`, timestamp: Date.now(), scope,
          result: { models: [model], hasMore: false, nextCursor: null },
        }],
      }));
      storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
        version: 6,
        entries: [{ key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model }],
      }));

      const store = new ModelCatalogCacheStore();
      const searchModel = store.getSearch(scope, 1000)?.models[0] as ModelMetadata;
      const snapshotModel = store.getModelSnapshot(id, 'anon', 1000) as ModelMetadata;
      for (const cached of [searchModel, snapshotModel]) {
        expect(cached.projectorCandidates).toEqual([]);
        expect(cached.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector') ?? false)
          .toBe(false);
        expect(sanitizeCatalogModelRuntimeState(cached)).toEqual(cached);
      }

      const reloadedStore = new ModelCatalogCacheStore();
      expect(reloadedStore.getSearch(scope, 1000)?.models[0]).toEqual(searchModel);
      expect(reloadedStore.getModelSnapshot(id, 'anon', 1000)).toEqual(snapshotModel);
      expect(JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string).version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
      expect(JSON.parse(storage.getString(SNAPSHOT_CACHE_KEY) as string).version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
    },
  );

  it('fails closed for a raw projector artifact without a multimodal requirement', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'identity/raw-empty-projector-requirement';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const projector = buildProjectorCandidate(id, 'audio-projector', 'audio/mmproj.gguf');
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: projector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [buildProjectorArtifact(id, projector.id, projector.fileName, ['text'])],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`, timestamp: Date.now(), scope,
        result: { models: [model], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{ key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model }],
    }));

    const store = new ModelCatalogCacheStore();
    expect(store.getSearch(scope, 1000)?.models[0]?.projectorCandidates).toEqual([]);
    expect(store.getModelSnapshot(id, 'anon', 1000)?.projectorCandidates).toEqual([]);
  });

  it('counts a malformed raw path when resolving legacy basename ambiguity', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'identity/raw-malformed-legacy-alias';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const validProjector = buildProjectorCandidate(id, 'valid-projector', 'vision/mmproj.gguf');
    const malformedProjector = buildProjectorCandidate(id, 'malformed-projector', '/audio/mmproj.gguf');
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'mmproj.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [validProjector, malformedProjector],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`, timestamp: Date.now(), scope,
        result: { models: [model], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 6,
      entries: [{ key: `${id}::anon`, id, authScope: 'anon', timestamp: Date.now(), model }],
    }));

    const store = new ModelCatalogCacheStore();
    expect(store.getSearch(scope, 1000)?.models[0]?.projectorCandidates).toBeUndefined();
    expect(store.getModelSnapshot(id, 'anon', 1000)?.projectorCandidates).toBeUndefined();
  });

  it('round-trips an exact nested projector identity under its current id', () => {
    const id = 'identity/nested-happy-path';
    const projector = buildProjectorCandidate(
      id,
      'nested-projector',
      'Projectors/Audio + Vision/MMProj-A.GGUF',
    );
    const model = buildModel({
      id,
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'Projectors\\Audio + Vision\\MMProj-A.GGUF', confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector],
      artifacts: [buildProjectorArtifact(id, projector.id, projector.fileName, ['audio'])],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.projectorCandidates?.[0]).toEqual(expect.objectContaining({
        id: getCurrentProjectorId(projector),
        repoId: id,
        fileName: projector.fileName,
        downloadUrl: buildHuggingFaceResolveUrl(id, projector.fileName, 'main'),
      }));
      expect(cached.artifacts?.find((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual(expect.objectContaining({ remoteFileName: projector.fileName }));
    }
  });

  it('rederives a stale Q4 main artifact from the model-level Q8 identity', () => {
    const id = 'identity/main-artifact';
    const resolvedFileName = 'weights/model.Q8_0.gguf';
    const model = buildModel({
      id,
      resolvedFileName,
      hfRevision: 'main',
      downloadUrl: buildHuggingFaceResolveUrl(id, resolvedFileName, 'main'),
      size: 8_000,
      sha256: 'a'.repeat(64),
      artifacts: [{
        id: 'stale-q4-main',
        kind: 'main_model',
        requiredFor: ['audio'],
        hfRevision: 'main',
        remoteFileName: 'weights/model.Q4_K_M.gguf',
        downloadUrl: buildHuggingFaceResolveUrl(id, 'weights/model.Q4_K_M.gguf', 'main'),
        sizeBytes: 4_000,
        installState: 'remote',
      }],
    });

    for (const cached of roundTripAnonymousModel(model)) {
      expect(cached.artifacts?.find((artifact) => artifact.kind === 'main_model'))
        .toEqual(expect.objectContaining({
          remoteFileName: resolvedFileName,
          downloadUrl: buildHuggingFaceResolveUrl(id, resolvedFileName, 'main'),
          sizeBytes: 8_000,
          requiredFor: ['text'],
        }));
      expect(JSON.stringify(cached)).not.toContain('Q4_K_M');
    }
  });

  it('keeps an explicit same-repository draft directory as remote anonymous MTP metadata', () => {
    const id = 'unsloth/gemma-4-12b-it-GGUF';
    const draftArtifactId = 'mtp-draft-gemma';
    const model = buildModel({
      id,
      size: 7_000_000_000,
      resolvedFileName: 'gemma-4-12b-it-Q4_K_M.gguf',
      downloadUrl: buildHuggingFaceResolveUrl(id, 'gemma-4-12b-it-Q4_K_M.gguf', 'main'),
      hfRevision: 'main',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      artifacts: [{
        id: draftArtifactId,
        kind: 'speculative_draft',
        requiredFor: ['text'],
        hfRevision: 'main',
        remoteFileName: 'draft/gemma-4-12b-it-Q8_0.gguf',
        downloadUrl: buildHuggingFaceResolveUrl(id, 'draft/gemma-4-12b-it-Q8_0.gguf', 'main'),
        sizeBytes: 465_000_000,
        localPath: 'private-gemma-mtp.gguf',
        installState: 'installed',
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId,
      },
    });

    for (const cached of roundTripAnonymousModel(model)) {
      const cachedDraft = cached.artifacts?.find((artifact) => artifact.kind === 'speculative_draft');
      expect(cachedDraft).toEqual(
        expect.objectContaining({
          id: draftArtifactId,
          remoteFileName: 'draft/gemma-4-12b-it-Q8_0.gguf',
          installState: 'remote',
        }),
      );
      expect(cachedDraft).not.toHaveProperty('localPath');
      expect(cached.speculativeDecoding).toEqual(expect.objectContaining({
        mode: 'draft_model',
        draftArtifactId,
      }));
    }
  });

  it('drops local-only main artifacts even when a resolved filename is present', () => {
    const sanitized = sanitizeCatalogModelRuntimeState(buildModel({
      id: 'matrix/local-main-artifact',
      resolvedFileName: 'model.Q4_K_M.gguf',
      artifacts: [{
        id: 'main-local',
        kind: 'main_model',
        requiredFor: ['text'],
        remoteFileName: 'model.Q4_K_M.gguf',
        downloadUrl: 'file:///private/model.Q4_K_M.gguf',
        sizeBytes: 1024,
        localPath: 'private-model.Q4_K_M.gguf',
        installState: 'installed',
      }],
    }));

    expect(sanitized.artifacts).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain('file:///private');
    expect(sanitizeCatalogModelRuntimeState(sanitized)).toEqual(sanitized);
  });

  it('migrates mixed safe/unsafe v4 search and snapshot payloads to sanitized current state', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const scope = {
      query: 'migration/safe-vision',
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon' as const,
    };
    const legacyModel = buildModel({
      id: 'migration/safe-vision',
      chatModalities: ['text', 'vision', 'audio'],
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      inputCapabilities: {
        detectedAt: 99,
        declared: { image: 'supported', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'tag', value: 'vision', confidence: 'medium' },
          { source: 'runtime', value: 'audio', confidence: 'high' },
          { source: 'projector', value: 'mmproj-migration.gguf', confidence: 'medium' },
        ],
      },
      selectedProjectorId: 'projector-migration',
      multimodalReadiness: {
        modelId: 'migration/safe-vision',
        status: 'ready',
        projectorId: 'projector-migration',
        support: ['vision', 'audio'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 98,
      },
      projectorCandidates: [
        buildProjectorCandidate(
          'migration/safe-vision',
          'projector-migration',
          'mmproj-migration.gguf',
        ),
      ],
      artifacts: [
        buildProjectorArtifact(
          'migration/safe-vision',
          'projector-migration',
          'mmproj-migration.gguf',
          ['image', 'audio'],
        ),
      ],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [{
        key: 'migration/safe-vision::__initial__::20::__default__::anon',
        timestamp: Date.now(),
        scope,
        result: { models: [legacyModel], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 4,
      entries: [{
        key: 'migration/safe-vision::anon',
        id: 'migration/safe-vision',
        authScope: 'anon',
        timestamp: Date.now(),
        model: legacyModel,
      }],
    }));

    const store = new ModelCatalogCacheStore();
    const migratedModels = [
      store.getSearch(scope, 1000)?.models[0],
      store.getModelSnapshot('migration/safe-vision', 'anon', 1000),
    ];
    for (const model of migratedModels) {
      expect(model?.chatModalities).toEqual(['text', 'vision']);
      expect(model?.inputCapabilities?.declared.audio).toBe('unknown');
      expect(model?.inputCapabilities?.evidence.some((entry) => entry.source === 'runtime')).toBe(false);
      expect(model?.artifacts?.find((artifact) => artifact.kind === 'multimodal_projector')?.requiredFor)
        .toEqual(['image']);
      expect(model?.multimodalReadiness).toBeUndefined();
      expect(resolveModelNativeMultimodalSupport(model as ModelMetadata))
        .toEqual({ vision: true, audio: false });
    }

    const persistedSearch = JSON.parse(storage.getString(SEARCH_CACHE_KEY) as string) as any;
    const persistedSnapshot = JSON.parse(storage.getString(SNAPSHOT_CACHE_KEY) as string) as any;
    expect(persistedSearch.version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
    expect(persistedSnapshot.version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
    for (const persistedModel of [
      persistedSearch.entries[0].result.models[0],
      persistedSnapshot.entries[0].model,
    ]) {
      expect(persistedModel.inputCapabilities.declared.audio).toBe('unknown');
      expect(persistedModel.inputCapabilities.evidence).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'runtime' }),
      ]));
      expect(persistedModel.artifacts.find(
        (artifact: any) => artifact.kind === 'multimodal_projector',
      ).requiredFor).toEqual(['image']);
    }
  });

  it('rewrites legacy v5 payloads when inputCapabilities alone contain unsafe runtime evidence', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const scope = { query: 'rewrite', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const unsafeModel = buildModel({
      id: 'rewrite/runtime-input-only',
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 77,
        declared: { image: 'unknown', audio: 'supported', video: 'supported' },
        evidence: [
          { source: 'runtime', value: 'audio', confidence: 'high' },
          VIDEO_CATALOG_EVIDENCE,
        ],
      },
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 5,
      entries: [{
        key: 'rewrite::__initial__::20::__default__::anon',
        timestamp: Date.now(),
        scope,
        result: { models: [unsafeModel], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 5,
      entries: [{
        key: 'rewrite/runtime-input-only::anon',
        id: 'rewrite/runtime-input-only',
        authScope: 'anon',
        timestamp: Date.now(),
        model: unsafeModel,
      }],
    }));

    const store = new ModelCatalogCacheStore();
    expect(store.getSearch(scope, 1000)?.models[0]?.chatModalities).toEqual(['text']);
    expect(store.getModelSnapshot('rewrite/runtime-input-only', 'anon', 1000)?.chatModalities)
      .toEqual(['text']);
    for (const key of [SEARCH_CACHE_KEY, SNAPSHOT_CACHE_KEY]) {
      const raw = storage.getString(key) as string;
      expect(raw).not.toContain('"source":"runtime"');
      expect(raw).toContain('"audio":"unknown"');
      expect(raw).toContain('"video":"supported"');
    }
  });

  it('drops a runtime-only video declaration when its evidence is removed', () => {
    const sourceModel = buildModel({
      id: 'rewrite/runtime-video-only',
      chatModalities: ['text'],
      inputCapabilities: {
        detectedAt: 88,
        declared: { image: 'unknown', audio: 'unknown', video: 'supported' },
        evidence: [{ source: 'runtime', value: 'video', confidence: 'high' }],
      },
    });
    const sanitized = sanitizeCatalogModelRuntimeState(sourceModel);

    expect(sanitized.inputCapabilities).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain('"source":"runtime"');
    expect(sanitizeCatalogModelRuntimeState(sanitized)).toEqual(sanitized);
  });

  it('rewrites raw legacy v5 search and snapshot models before duplicate normalization can hide private state', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'rewrite/raw-duplicate-projector';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const safeProjector = buildProjectorCandidate(id, 'shared-projector-id', 'mmproj-safe.gguf');
    const privateDuplicate = {
      ...safeProjector,
      fileName: 'mmproj-private-duplicate.gguf',
      downloadUrl: 'file:///private/mmproj-private-duplicate.gguf',
      localPath: 'private-duplicate-local-path.gguf',
      matchStatus: 'user_selected' as const,
      matchReason: 'user_selected_projector',
    };
    const rawModel = buildModel({
      id,
      chatModalities: ['text', 'vision'],
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [
          { source: 'tag', value: 'vision', confidence: 'medium' },
          { source: 'projector', value: safeProjector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [safeProjector, privateDuplicate],
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: 5,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`,
        timestamp: Date.now(),
        scope,
        result: { models: [rawModel], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: 5,
      entries: [{
        key: `${id}::anon`,
        id,
        authScope: 'anon',
        timestamp: Date.now(),
        model: rawModel,
      }],
    }));

    const store = new ModelCatalogCacheStore();
    for (const model of [
      store.getSearch(scope, 1000)?.models[0],
      store.getModelSnapshot(id, 'anon', 1000),
    ]) {
      expect(model?.projectorCandidates).toEqual([
        expect.objectContaining({
          id: getCurrentProjectorId(safeProjector),
          fileName: safeProjector.fileName,
        }),
      ]);
    }

    for (const key of [SEARCH_CACHE_KEY, SNAPSHOT_CACHE_KEY]) {
      const raw = storage.getString(key) as string;
      expect(JSON.parse(raw).version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
      expect(raw).toContain('mmproj-safe.gguf');
      expect(raw).not.toContain('file:///private');
      expect(raw).not.toContain('mmproj-private-duplicate.gguf');
      expect(raw).not.toContain('private-duplicate-local-path.gguf');
    }

    const rewrittenSearch = storage.getString(SEARCH_CACHE_KEY);
    const rewrittenSnapshot = storage.getString(SNAPSHOT_CACHE_KEY);
    new ModelCatalogCacheStore();
    expect(storage.getString(SEARCH_CACHE_KEY)).toBe(rewrittenSearch);
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBe(rewrittenSnapshot);
  });

  it('rewrites unmarked current-version search and snapshot payloads after field-level sanitization', () => {
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const id = 'rewrite/current-version-runtime-state';
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const unsafeModel = buildModel({
      id,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 0.75,
      localPath: 'private-current-version-model.gguf',
      resumeData: 'private-current-version-resume-token',
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 91,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [{ source: 'runtime', value: 'audio', confidence: 'high' }],
      },
    });
    storage.set(SEARCH_CACHE_KEY, JSON.stringify({
      version: MODEL_CATALOG_CACHE_PERSISTED_VERSION,
      entries: [{
        key: `${id}::__initial__::20::__default__::anon`,
        timestamp: Date.now(),
        scope,
        result: { models: [unsafeModel], hasMore: false, nextCursor: null },
      }],
    }));
    storage.set(SNAPSHOT_CACHE_KEY, JSON.stringify({
      version: MODEL_CATALOG_CACHE_PERSISTED_VERSION,
      entries: [{
        key: `${id}::anon`,
        id,
        authScope: 'anon',
        timestamp: Date.now(),
        model: unsafeModel,
      }],
    }));

    const store = new ModelCatalogCacheStore();
    const cachedModels = [
      store.getSearch(scope, 1000)?.models[0],
      store.getModelSnapshot(id, 'anon', 1000),
    ];
    for (const model of cachedModels) {
      expect(model?.localPath).toBeUndefined();
      expect(model?.resumeData).toBeUndefined();
      expect(model?.chatModalities).toEqual(['text']);
      expect(model?.inputCapabilities).toBeUndefined();
    }

    for (const key of [SEARCH_CACHE_KEY, SNAPSHOT_CACHE_KEY]) {
      const raw = storage.getString(key) as string;
      const persisted = JSON.parse(raw);
      expect(persisted.version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
      expect(persisted.sanitized).toBe(true);
      expect(raw).not.toContain('private-current-version-model.gguf');
      expect(raw).not.toContain('private-current-version-resume-token');
      expect(raw).not.toContain('"source":"runtime"');
    }
  });

  it('retains parent catalog audio evidence for a safe variant-only projector', () => {
    const id = 'variant/audio-only-projector';
    const audioVariantId = 'audio.Q4_K_M.gguf';
    const textVariantId = 'text.Q4_K_M.gguf';
    const audioProjector = buildProjectorCandidate(
      id,
      'variant-audio-projector',
      'mmproj-variant-audio.gguf',
    );
    audioProjector.ownerVariantId = audioVariantId;
    const unrelatedLocalProjector = buildProjectorCandidate(
      id,
      'variant-local-projector',
      'mmproj-variant-local.gguf',
      { localOnly: true },
    );
    unrelatedLocalProjector.ownerVariantId = textVariantId;
    const sourceModel = buildModel({
      id,
      resolvedFileName: audioVariantId,
      activeVariantId: audioVariantId,
      chatModalities: ['text'],
      inputCapabilities: {
        detectedAt: 1234,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: audioProjector.fileName, confidence: 'medium' },
        ],
      },
      variants: [
        {
          variantId: audioVariantId,
          fileName: audioVariantId,
          quantizationLabel: 'Q4_K_M',
          size: 1024,
          isLocal: true,
          chatModalities: ['text', 'audio'],
          selectedProjectorId: audioProjector.id,
          projectorCandidates: [audioProjector],
        },
        {
          variantId: textVariantId,
          fileName: textVariantId,
          quantizationLabel: 'Q4_K_M',
          size: 2048,
          isLocal: true,
          chatModalities: ['text'],
          selectedProjectorId: unrelatedLocalProjector.id,
          projectorCandidates: [unrelatedLocalProjector],
        },
      ],
    });
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const store = new ModelCatalogCacheStore();
    store.putSearch(scope, { models: [sourceModel], hasMore: false, nextCursor: null });
    store.putModelSnapshots([sourceModel], 'anon');
    const reloadedStore = new ModelCatalogCacheStore();

    for (const model of [
      sanitizeCatalogModelRuntimeState(sourceModel),
      reloadedStore.getSearch(scope, 1000)?.models[0],
      reloadedStore.getModelSnapshot(id, 'anon', 1000),
    ]) {
      expect(model?.chatModalities).toEqual(['text']);
      expect(model?.inputCapabilities?.declared.audio).toBe('supported');
      expect(model?.inputCapabilities?.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'pipeline_tag' }),
        expect.objectContaining({ source: 'projector', value: 'mmproj-variant-audio.gguf' }),
      ]));
      const audioVariant = model?.variants?.find((variant) => variant.variantId === audioVariantId);
      expect(audioVariant?.chatModalities).toEqual(['text', 'audio']);
      expect(audioVariant?.isLocal).toBeUndefined();
      expect(audioVariant?.selectedProjectorId).toBeUndefined();
      expect(audioVariant?.projectorCandidates).toEqual([
        expect.objectContaining({
          id: getCurrentProjectorId(audioProjector),
          fileName: audioProjector.fileName,
          lifecycleStatus: 'available',
        }),
      ]);
      expect(audioVariant?.projectorCandidates?.[0]?.localPath).toBeUndefined();
      expect(resolveEffectiveActiveVariantNativeSupport(model as ModelMetadata))
        .toEqual({ vision: false, audio: true });

      const textVariant = model?.variants?.find((variant) => variant.variantId === textVariantId);
      expect(textVariant?.chatModalities).toEqual(['text']);
      expect(textVariant?.isLocal).toBeUndefined();
      expect(textVariant?.selectedProjectorId).toBeUndefined();
      expect(textVariant?.projectorCandidates).toBeUndefined();
    }
  });

  it('inherits parent catalog vision evidence for an explicit vision variant and owner-scoped model projector', () => {
    const id = 'variant/inherited-vision';
    const variantId = 'vision.Q4_K_M.gguf';
    const projector = buildProjectorCandidate(id, 'vision-projector', 'mmproj-vision-owner.gguf');
    projector.ownerVariantId = variantId;
    const unrelatedImpostor = buildProjectorCandidate(id, 'impostor-projector', 'mmproj-impostor.gguf');
    unrelatedImpostor.ownerVariantId = variantId;
    unrelatedImpostor.matchStatus = 'user_selected';
    unrelatedImpostor.matchReason = 'user_selected_projector';
    const sourceModel = buildModel({
      id,
      resolvedFileName: variantId,
      activeVariantId: variantId,
      chatModalities: ['text'],
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      inputCapabilities: {
        detectedAt: 222,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [
          { source: 'tag', value: 'vision', confidence: 'medium' },
          { source: 'projector', value: projector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector, unrelatedImpostor],
      artifacts: [buildProjectorArtifact(id, projector.id, projector.fileName, ['image'])],
      variants: [{
        variantId,
        fileName: variantId,
        quantizationLabel: 'Q4_K_M',
        size: 1024,
        chatModalities: ['text', 'vision'],
      }],
    });
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const directModel = sanitizeCatalogModelRuntimeState(sourceModel);
    expect(sanitizeCatalogModelRuntimeState(directModel)).toEqual(directModel);
    const store = new ModelCatalogCacheStore();
    store.putSearch(scope, { models: [sourceModel], hasMore: false, nextCursor: null });
    store.putModelSnapshots([sourceModel], 'anon');
    const reloadedStore = new ModelCatalogCacheStore();

    for (const model of [
      directModel,
      reloadedStore.getSearch(scope, 1000)?.models[0],
      reloadedStore.getModelSnapshot(id, 'anon', 1000),
    ]) {
      expect(model?.chatModalities).toEqual(['text']);
      expect(model?.visionSource).toBe('catalog_metadata');
      expect(model?.projectorCandidates).toEqual([
        expect.objectContaining({
          id: getCurrentProjectorId(projector),
          fileName: projector.fileName,
        }),
      ]);
      expect(model?.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({
          id: getCurrentProjectorId(projector),
          requiredFor: ['image'],
        })]);
      expect(model?.variants?.[0]?.chatModalities).toEqual(['text', 'vision']);
      expect(resolveEffectiveActiveVariantNativeSupport(model as ModelMetadata))
        .toEqual({ vision: true, audio: false });
    }
  });

  it('does not let an installed artifact authorize an unrelated user-selected vision candidate', () => {
    const id = 'catalog/vision-artifact-provenance';
    const safeProjector = buildProjectorCandidate(id, 'catalog-projector', 'mmproj-catalog.gguf');
    const userSelectedProjector = buildProjectorCandidate(
      id,
      'user-selected-projector',
      'mmproj-user-selected.gguf',
    );
    userSelectedProjector.matchStatus = 'user_selected';
    userSelectedProjector.matchReason = 'user_selected_projector';
    userSelectedProjector.localPath = 'private-user-selected-projector.gguf';
    const sourceModel = buildModel({
      id,
      chatModalities: ['text', 'vision'],
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [
          { source: 'tag', value: 'vision', confidence: 'medium' },
          { source: 'projector', value: safeProjector.fileName, confidence: 'medium' },
        ],
      },
      projectorCandidates: [safeProjector, userSelectedProjector],
      artifacts: [
        buildProjectorArtifact(id, safeProjector.id, safeProjector.fileName, ['image']),
        buildProjectorArtifact(
          id,
          userSelectedProjector.id,
          userSelectedProjector.fileName,
          ['image'],
        ),
      ],
    });
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const directModel = sanitizeCatalogModelRuntimeState(sourceModel);
    expect(sanitizeCatalogModelRuntimeState(directModel)).toEqual(directModel);
    const store = new ModelCatalogCacheStore();
    store.putSearch(scope, { models: [sourceModel], hasMore: false, nextCursor: null });
    store.putModelSnapshots([sourceModel], 'anon');
    const reloadedStore = new ModelCatalogCacheStore();

    for (const model of [
      directModel,
      reloadedStore.getSearch(scope, 1000)?.models[0],
      reloadedStore.getModelSnapshot(id, 'anon', 1000),
    ]) {
      expect(model?.projectorCandidates).toEqual([
        expect.objectContaining({
          id: getCurrentProjectorId(safeProjector),
          fileName: safeProjector.fileName,
        }),
      ]);
      expect(model?.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({
          id: getCurrentProjectorId(safeProjector),
          remoteFileName: safeProjector.fileName,
          requiredFor: ['image'],
        })]);
    }
    expect(createStorage(STORAGE_ID, { tier: 'cache' }).getString(SEARCH_CACHE_KEY))
      .not.toContain('mmproj-user-selected.gguf');
    expect(createStorage(STORAGE_ID, { tier: 'cache' }).getString(SNAPSHOT_CACHE_KEY))
      .not.toContain('mmproj-user-selected.gguf');
  });

  it('retains an owner-scoped model audio projector for a safe audio variant without leaking paths', () => {
    const id = 'variant/model-level-audio';
    const audioVariantId = 'audio-owner.Q4_K_M.gguf';
    const textVariantId = 'text-owner.Q4_K_M.gguf';
    const projector = buildProjectorCandidate(
      id,
      'audio-owner-projector',
      'projectors/audio/mmproj-owner-audio.gguf',
    );
    projector.ownerVariantId = audioVariantId;
    const unrelated = buildProjectorCandidate(id, 'unrelated-projector', 'mmproj-unrelated.gguf');
    unrelated.ownerVariantId = textVariantId;
    const audioArtifact = buildProjectorArtifact(
      id,
      projector.id,
      projector.fileName,
      ['audio'],
    );
    const sourceModel = buildModel({
      id,
      resolvedFileName: audioVariantId,
      activeVariantId: audioVariantId,
      chatModalities: ['text'],
      inputCapabilities: {
        detectedAt: 333,
        declared: { image: 'unknown', audio: 'supported', video: 'unknown' },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
          { source: 'projector', value: 'projectors\\audio\\mmproj-owner-audio.gguf', confidence: 'medium' },
        ],
      },
      projectorCandidates: [projector, unrelated],
      artifacts: [
        audioArtifact,
        buildProjectorArtifact(id, unrelated.id, unrelated.fileName, ['audio']),
      ],
      variants: [
        {
          variantId: audioVariantId,
          fileName: audioVariantId,
          quantizationLabel: 'Q4_K_M',
          size: 1024,
          chatModalities: ['text', 'audio'],
        },
        {
          variantId: textVariantId,
          fileName: textVariantId,
          quantizationLabel: 'Q4_K_M',
          size: 2048,
          chatModalities: ['text'],
        },
      ],
    });
    const scope = { query: id, cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    const directModel = sanitizeCatalogModelRuntimeState(sourceModel);
    expect(sanitizeCatalogModelRuntimeState(directModel)).toEqual(directModel);
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    store.putSearch(scope, { models: [sourceModel], hasMore: false, nextCursor: null });
    store.putModelSnapshots([sourceModel], 'anon');
    const reloadedStore = new ModelCatalogCacheStore();

    for (const model of [
      directModel,
      reloadedStore.getSearch(scope, 1000)?.models[0],
      reloadedStore.getModelSnapshot(id, 'anon', 1000),
    ]) {
      expect(model?.chatModalities).toEqual(['text']);
      expect(model?.inputCapabilities?.evidence).toContainEqual(expect.objectContaining({
        source: 'projector',
        value: projector.fileName,
      }));
      expect(model?.projectorCandidates).toEqual([
        expect.objectContaining({
          id: getCurrentProjectorId(projector),
          fileName: projector.fileName,
        }),
      ]);
      expect(model?.artifacts?.filter((artifact) => artifact.kind === 'multimodal_projector'))
        .toEqual([expect.objectContaining({
          id: getCurrentProjectorId(projector),
          remoteFileName: projector.fileName,
          requiredFor: ['audio'],
        })]);
      expect(resolveEffectiveActiveVariantNativeSupport(model as ModelMetadata))
        .toEqual({ vision: false, audio: true });
    }
    expect(storage.getString(SEARCH_CACHE_KEY)).not.toContain('private');
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).not.toContain('private');
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
    expect(persisted.version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
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
        inputCapabilities: {
          detectedAt: 123,
          declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
          evidence: [
            { source: 'tag', value: 'vision', confidence: 'medium' },
            { source: 'projector', value: 'mmproj-model-f16.gguf', confidence: 'medium' },
          ],
        },
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
      id: buildProjectorArtifactId({
        repoId: 'public/vision-model',
        hfRevision: 'main',
        fileName: 'mmproj-model-f16.gguf',
      }),
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
        id: buildProjectorArtifactId({
          repoId: 'public/audio-only-model',
          hfRevision: 'main',
          fileName: 'mmproj-audio-model-f16.gguf',
        }),
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
        id: buildProjectorArtifactId({
          repoId: 'public/audio-only-model',
          hfRevision: 'main',
          fileName: 'mmproj-audio-model-f16.gguf',
        }),
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
      expect(cachedModel?.chatModalities).toEqual(['text']);
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
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [
          { source: 'projector', value: 'mmproj-selected-f16.gguf', confidence: 'medium' },
          { source: 'projector', value: 'mmproj-ambiguous-f16.gguf', confidence: 'medium' },
        ],
      },
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
      const selected = projectors?.find((projector) => (
        projector.fileName === 'mmproj-selected-f16.gguf'
      ));
      const ambiguous = projectors?.find((projector) => (
        projector.fileName === 'mmproj-ambiguous-f16.gguf'
      ));

      expect(selected).toEqual(expect.objectContaining({
        id: buildProjectorArtifactId({
          repoId: 'public/vision-affinity-model',
          hfRevision: 'main',
          fileName: 'mmproj-selected-f16.gguf',
        }),
        lifecycleStatus: 'available',
        matchStatus: 'matched',
        matchReason: 'deterministic_filename_affinity',
      }));
      expect(selected?.localPath).toBeUndefined();
      expect(selected?.resumeData).toBeUndefined();
      expect(ambiguous).toEqual(expect.objectContaining({
        id: buildProjectorArtifactId({
          repoId: 'public/vision-affinity-model',
          hfRevision: 'main',
          fileName: 'mmproj-ambiguous-f16.gguf',
        }),
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
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [{ source: 'projector', value: 'mmproj-model-q4.gguf', confidence: 'medium' }],
      },
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
        id: buildProjectorArtifactId({
          repoId: 'public/vision-variant-model',
          hfRevision: 'main',
          fileName: 'mmproj-model-q4.gguf',
          ownerVariantId: 'q4',
        }),
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
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [{ source: 'projector', value: 'mmproj-search-f16.gguf', confidence: 'medium' }],
      },
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
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [{ source: 'projector', value: 'mmproj-variant-f16.gguf', confidence: 'medium' }],
      },
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
      id: buildProjectorArtifactId({
        repoId: 'public/legacy-search-projector-resume',
        hfRevision: 'main',
        fileName: 'mmproj-search-f16.gguf',
      }),
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    }));
    expect(searchProjector?.resumeData).toBeUndefined();
    expect(snapshotVariantProjector).toEqual(expect.objectContaining({
      id: buildProjectorArtifactId({
        repoId: 'public/legacy-variant-projector-resume',
        hfRevision: 'main',
        fileName: 'mmproj-variant-f16.gguf',
        ownerVariantId: 'q4',
      }),
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
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [{ source: 'projector', value: 'mmproj-search-f16.gguf', confidence: 'medium' }],
      },
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
      inputCapabilities: {
        detectedAt: 1,
        declared: { image: 'supported', audio: 'unknown', video: 'unknown' },
        evidence: [{ source: 'projector', value: 'mmproj-variant-f16.gguf', confidence: 'medium' }],
      },
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

  it('migrates version 3 search payloads to the current version with variant limiting', () => {
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
    expect(persisted.version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
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

  it('migrates version 3 snapshot payloads to the current version with anonymous sanitization', () => {
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
    expect(persisted.version).toBe(MODEL_CATALOG_CACHE_PERSISTED_VERSION);
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
    expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBeUndefined();
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

  it('propagates clearSnapshots removal failures instead of reporting a successful clear', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const model = buildModel({ id: 'clear/snapshot-remove-failure' });
    store.putModelSnapshots([model], 'anon');
    const persistedSnapshot = storage.getString(SNAPSHOT_CACHE_KEY);
    const removeError = new Error('snapshot remove failed');
    const storeStorage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const originalRemove = storeStorage.remove.bind(storeStorage);
    const removeSpy = jest.spyOn(storeStorage, 'remove').mockImplementation((key) => {
      if (key === SNAPSHOT_CACHE_KEY) {
        throw removeError;
      }
      return originalRemove(key);
    });

    try {
      expect(() => store.clearSnapshots()).toThrow(removeError);
      expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBe(persistedSnapshot);
      expect(store.getModelSnapshot(model.id, 'anon', 1000)).toBeNull();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('propagates clearAll removal failures after attempting every persisted cache key', () => {
    const store = new ModelCatalogCacheStore();
    const storage = createStorage(STORAGE_ID, { tier: 'cache' });
    const scope = { query: 'clear-all', cursor: null, pageSize: 20, sort: null, authScope: 'anon' as const };
    store.putSearch(scope, {
      models: [buildModel({ id: 'clear/search-remove-failure' })],
      hasMore: false,
      nextCursor: null,
    });
    store.putModelSnapshots([buildModel({ id: 'clear/snapshot-after-search-failure' })], 'anon');
    const persistedSearch = storage.getString(SEARCH_CACHE_KEY);
    const removeError = new Error('search remove failed');
    const storeStorage = (store as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const originalRemove = storeStorage.remove.bind(storeStorage);
    const removeSpy = jest.spyOn(storeStorage, 'remove').mockImplementation((key) => {
      if (key === SEARCH_CACHE_KEY) {
        throw removeError;
      }
      return originalRemove(key);
    });

    try {
      expect(() => store.clearAll()).toThrow(removeError);
      expect(removeSpy).toHaveBeenCalledWith(SEARCH_CACHE_KEY);
      expect(removeSpy).toHaveBeenCalledWith(SNAPSHOT_CACHE_KEY);
      expect(storage.getString(SEARCH_CACHE_KEY)).toBe(persistedSearch);
      expect(storage.getString(SNAPSHOT_CACHE_KEY)).toBeUndefined();
      expect(store.getSearch(scope, 1000)).toBeNull();
    } finally {
      removeSpy.mockRestore();
    }
  });
});
