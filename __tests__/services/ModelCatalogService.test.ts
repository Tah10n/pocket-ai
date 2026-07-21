import DeviceInfo from 'react-native-device-info';
import * as SecureStore from 'expo-secure-store';
import {
  ModelCatalogError,
  ModelCatalogService,
  modelCatalogService,
} from '../../src/services/ModelCatalogService';
import { getSystemMemorySnapshot } from '../../src/services/SystemMetricsService';
import { huggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { REQUEST_AUTH_POLICY } from '../../src/types/huggingFace';
import { CATALOG_SEARCH_VARIANT_LIMIT } from '../../src/services/ModelCatalogFileSelector';
import { ModelCatalogCacheStore } from '../../src/services/ModelCatalogCacheStore';
import { createStorage } from '../../src/services/storage';
import { performanceMonitor } from '../../src/services/PerformanceMonitor';

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    getCurrentStatus: jest.fn().mockReturnValue({ isConnected: true }),
  },
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModels: jest.fn(),
    getModel: jest.fn(),
    updateModel: jest.fn(),
  },
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/mock/',
  getInfoAsync: jest.fn(),
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn(),
  getFreeDiskStorage: jest.fn(),
}));

jest.mock('../../src/services/SystemMetricsService', () => ({
  getSystemMemorySnapshot: jest.fn().mockResolvedValue(null),
}));

const mockedRegistry = registry as jest.Mocked<typeof registry>;
const TREE_SHA256 = 'a'.repeat(64);
const LOCAL_SHA256 = 'b'.repeat(64);
const OTHER_TREE_SHA256 = 'c'.repeat(64);
const PAGED_TREE_SHA256 = 'd'.repeat(64);
const PROJECTOR_CACHE_SHA256 = 'e'.repeat(64);

function makeRepo(
  id: string,
  size = 1.5 * 1024 * 1024 * 1024,
  filename = 'model.Q4_K_M.gguf',
) {
  return {
    id,
    siblings: [
      {
        rfilename: filename,
        size,
      },
    ],
  };
}

function makeRepoWithUnknownSize(id: string, filename = 'model.Q4_K_M.gguf') {
  return {
    id,
    siblings: [
      {
        rfilename: filename,
      },
    ],
  };
}

function makeFilenameOnlyRepo(id: string) {
  return {
    id,
    siblings: [
      {
        filename: 'model.Q8_0.gguf',
        size: 5 * 1024 * 1024 * 1024,
      },
      {
        filename: 'model.Q4_K_M.gguf',
        size: 3 * 1024 * 1024 * 1024,
      },
    ],
  };
}

function makeGatedRepo(id: string, filename = 'model.Q4_K_M.gguf') {
  return {
    ...makeRepoWithUnknownSize(id, filename),
    gated: 'manual',
  };
}

function makeIncompletePublicRepo(id: string) {
  return {
    id,
    tags: ['gguf', 'chat'],
  };
}

function makeRevisionRepo(
  id: string,
  revision = 'cafebabe1234',
  filename = 'folder/model Q4+#.gguf',
  size = 1.5 * 1024 * 1024 * 1024,
) {
  return {
    id,
    sha: revision,
    siblings: [
      {
        rfilename: filename,
        size,
      },
    ],
  };
}

function makeLocalModel(id: string): ModelMetadata {
  return {
    id,
    name: id.split('/').pop() ?? id,
    author: id.split('/')[0] ?? 'local',
    size: 1024,
    downloadUrl: `https://example.com/${id}.gguf`,
    localPath: `${id.replace('/', '_')}.gguf`,
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1,
  };
}

function makeStaleProjectorCacheModel(id: string): ModelMetadata {
  const fileName = 'mmproj-model.Q4_K_M.gguf';
  return {
    ...makeLocalModel(id),
    size: 96 * 1024 * 1024,
    downloadUrl: `https://huggingface.co/${id}/resolve/main/${fileName}`,
    localPath: undefined,
    resolvedFileName: fileName,
    sha256: PROJECTOR_CACHE_SHA256,
    requiresTreeProbe: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

async function waitForMockCallCount(mockFn: jest.Mock, expectedCallCount: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (mockFn.mock.calls.length >= expectedCallCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(mockFn.mock.calls.length).toBeGreaterThanOrEqual(expectedCallCount);
}

async function waitForCatalogRequestMapsToSettle(service: ModelCatalogService): Promise<void> {
  const requestMaps = service as unknown as {
    activeNetworkRequestControllers: Map<unknown, unknown>;
    searchRequestCache: Map<unknown, unknown>;
    deferredMetadataRequestCache: Map<unknown, unknown>;
    treeRequestCache: Map<unknown, unknown>;
    readmeRequestCache: Map<unknown, unknown>;
    resolvedFileProbeCache: Map<unknown, unknown>;
  };
  const getActiveCount = () => (
    requestMaps.activeNetworkRequestControllers.size
    + requestMaps.searchRequestCache.size
    + requestMaps.deferredMetadataRequestCache.size
    + requestMaps.treeRequestCache.size
    + requestMaps.readmeRequestCache.size
    + requestMaps.resolvedFileProbeCache.size
  );

  for (let attempt = 0; attempt < 50 && getActiveCount() > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(getActiveCount()).toBe(0);
}

describe('ModelCatalogService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    modelCatalogService.clearCache('manual');
    await huggingFaceTokenService.clearToken();
    mockedRegistry.getModels.mockReturnValue([]);
    mockedRegistry.getModel.mockReturnValue(undefined);
    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: true });
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024);
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue(null);
  });

  it('preserves an installed Gemma MTP drafter across a compatible catalog refresh', () => {
    const id = 'org/gemma-mtp-refresh';
    const revision = 'revision-a';
    const mainSha256 = '1'.repeat(64);
    const draftSha256 = '2'.repeat(64);
    const mainUrl = `https://huggingface.co/${id}/resolve/${revision}/model.Q4_K_M.gguf`;
    const draftUrl = `https://huggingface.co/${id}/resolve/${revision}/MTP/gemma-MTP-Q8_0.gguf`;
    const localModel: ModelMetadata = {
      ...makeLocalModel(id),
      downloadUrl: mainUrl,
      hfRevision: revision,
      resolvedFileName: 'model.Q4_K_M.gguf',
      sha256: mainSha256,
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 1024,
        checkedAt: 10,
        sha256: mainSha256,
      },
      artifacts: [{
        id: 'mtp-draft',
        kind: 'speculative_draft',
        requiredFor: ['text'],
        hfRevision: revision,
        remoteFileName: 'MTP/gemma-MTP-Q8_0.gguf',
        downloadUrl: draftUrl,
        sizeBytes: 200,
        sha256: draftSha256,
        localPath: 'gemma-mtp.gguf',
        installState: 'installed',
        downloadProgress: 1,
        integrity: {
          kind: 'sha256',
          sizeBytes: 200,
          checkedAt: 11,
          sha256: draftSha256,
        },
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId: 'mtp-draft',
      },
    };
    const remoteModel: ModelMetadata = {
      ...localModel,
      localPath: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      downloadIntegrity: undefined,
      artifacts: [{
        ...localModel.artifacts![0],
        localPath: undefined,
        installState: 'remote',
        downloadProgress: undefined,
        integrity: undefined,
      }],
    };
    mockedRegistry.getModel.mockReturnValue(localModel);
    const service = new ModelCatalogService();

    const merged = (service as unknown as {
      mergeModelWithRegistry: (model: ModelMetadata, memoryFitContext: null) => ModelMetadata;
    }).mergeModelWithRegistry(remoteModel, null);

    expect(merged.artifacts?.find((artifact) => artifact.id === 'mtp-draft')).toEqual(
      expect.objectContaining({
        localPath: 'gemma-mtp.gguf',
        installState: 'installed',
        downloadProgress: 1,
      }),
    );
    service.dispose();
  });

  it('replaces an obsolete local MTP drafter when the compatible catalog publishes a new one', () => {
    const id = 'org/gemma-mtp-replacement';
    const localModel: ModelMetadata = {
      ...makeLocalModel(id),
      resolvedFileName: 'model.Q4_K_M.gguf',
      artifacts: [{
        id: 'old-mtp-draft',
        kind: 'speculative_draft',
        requiredFor: ['text'],
        remoteFileName: 'MTP/gemma-MTP-Q8_0.gguf',
        downloadUrl: `https://huggingface.co/${id}/resolve/main/MTP/gemma-MTP-Q8_0.gguf`,
        sizeBytes: 200,
        localPath: 'old-gemma-mtp.gguf',
        installState: 'installed',
        downloadProgress: 1,
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId: 'old-mtp-draft',
      },
    };
    const remoteModel: ModelMetadata = {
      ...localModel,
      localPath: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      artifacts: [{
        id: 'new-mtp-draft',
        kind: 'speculative_draft',
        requiredFor: ['text'],
        remoteFileName: 'MTP/gemma-MTP-Q4_0.gguf',
        downloadUrl: `https://huggingface.co/${id}/resolve/main/MTP/gemma-MTP-Q4_0.gguf`,
        sizeBytes: 150,
        installState: 'remote',
      }],
      speculativeDecoding: {
        type: 'mtp',
        mode: 'draft_model',
        enabled: true,
        maxDraftTokens: 1,
        draftArtifactId: 'new-mtp-draft',
      },
    };
    mockedRegistry.getModel.mockReturnValue(localModel);
    const service = new ModelCatalogService();

    const merged = (service as unknown as {
      mergeModelWithRegistry: (model: ModelMetadata, memoryFitContext: null) => ModelMetadata;
    }).mergeModelWithRegistry(remoteModel, null);

    expect(merged.artifacts?.filter((artifact) => artifact.kind === 'speculative_draft')).toEqual([
      remoteModel.artifacts![0],
    ]);
    expect(merged.speculativeDecoding?.draftArtifactId).toBe('new-mtp-draft');
    service.dispose();
  });

  it('waits for deferred hydration before resolving an offline catalog fallback', async () => {
    const query = 'offline-ready';
    const cachedModel = makeLocalModel('org/offline-ready-model');
    const seedCache = new ModelCatalogCacheStore();
    seedCache.putSearch({
      query: `${query} gguf`,
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon',
    }, {
      models: [cachedModel],
      hasMore: false,
      nextCursor: null,
    });
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const invalidationListener = jest.fn();
    deferredService.subscribeCacheInvalidations(invalidationListener);
    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: false });
    global.fetch = jest.fn();
    let didSettle = false;

    const pendingResult = deferredService.searchModels(query).then((result) => {
      didSettle = true;
      return result;
    });
    await Promise.resolve();

    expect(didSettle).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();

    deferredService.hydratePersistentCache();
    const result = await pendingResult;

    expect(result.models.map((model) => model.id)).toEqual([cachedModel.id]);
    expect(invalidationListener).toHaveBeenCalledTimes(2);
    expect(invalidationListener).toHaveBeenNthCalledWith(1, 0, 'replay');
    expect(invalidationListener).toHaveBeenNthCalledWith(2, 1, 'hydrate');
    expect(global.fetch).not.toHaveBeenCalled();
    deferredService.dispose();
  });

  it('cancels a search that was waiting for hydration before a manual cache clear', async () => {
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    global.fetch = jest.fn();

    const pendingSearch = deferredService.searchModels('clear-before-hydration');
    await Promise.resolve();
    deferredService.clearCache('manual');

    await expect(pendingSearch).rejects.toMatchObject({ code: 'cancelled' });
    expect(global.fetch).not.toHaveBeenCalled();
    deferredService.dispose();
  });

  it('does not emit hydrate after a manual clear invalidates an incremental attempt', async () => {
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const persistentCache = (deferredService as unknown as {
      persistentCache: ModelCatalogCacheStore;
    }).persistentCache;
    const hydration = createDeferred<boolean>();
    const hydrateSpy = jest.spyOn(persistentCache, 'hydrateIncrementally').mockReturnValue(hydration.promise);
    const invalidationListener = jest.fn();
    deferredService.subscribeCacheInvalidations(invalidationListener);

    try {
      const hydrationAttempt = deferredService.hydratePersistentCacheIncrementally();
      deferredService.clearCache('manual');
      hydration.resolve(false);
      await hydrationAttempt;

      expect(invalidationListener.mock.calls).toEqual([
        [0, 'replay'],
        [1, 'manual'],
      ]);
    } finally {
      hydrateSpy.mockRestore();
      deferredService.dispose();
    }
  });

  it('emits hydrate only once when synchronous hydration supersedes an incremental attempt', async () => {
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const persistentCache = (deferredService as unknown as {
      persistentCache: ModelCatalogCacheStore;
    }).persistentCache;
    const hydration = createDeferred<boolean>();
    const hydrateSpy = jest.spyOn(persistentCache, 'hydrateIncrementally').mockReturnValue(hydration.promise);
    const invalidationListener = jest.fn();
    deferredService.subscribeCacheInvalidations(invalidationListener);

    try {
      const incrementalAttempt = deferredService.hydratePersistentCacheIncrementally();
      deferredService.hydratePersistentCache();
      hydration.resolve(true);
      await incrementalAttempt;

      expect(invalidationListener.mock.calls).toEqual([
        [0, 'replay'],
        [1, 'hydrate'],
      ]);
    } finally {
      hydrateSpy.mockRestore();
      deferredService.dispose();
    }
  });

  it('applies persisted data and completes the gate after successful incremental hydration', async () => {
    const query = 'incremental-hydration-success';
    const cachedModel = makeLocalModel('org/incremental-hydration-success');
    const seedCache = new ModelCatalogCacheStore();
    seedCache.putSearch({
      query: `${query} gguf`,
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon',
    }, {
      models: [cachedModel],
      hasMore: false,
      nextCursor: null,
    });
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const invalidationListener = jest.fn();
    deferredService.subscribeCacheInvalidations(invalidationListener);
    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: false });
    global.fetch = jest.fn();

    try {
      const pendingResult = deferredService.searchModels(query);
      await Promise.resolve();

      await deferredService.hydratePersistentCacheIncrementally();
      const result = await pendingResult;
      const hydrationState = deferredService as unknown as {
        persistentCacheHydrated: boolean;
        persistentCacheHydrationAttemptSettled: boolean;
        persistentCacheHydrationFailOpenTimer: ReturnType<typeof setTimeout> | undefined;
      };

      expect(result.models.map((model) => model.id)).toEqual([cachedModel.id]);
      expect(hydrationState.persistentCacheHydrated).toBe(true);
      expect(hydrationState.persistentCacheHydrationAttemptSettled).toBe(true);
      expect(hydrationState.persistentCacheHydrationFailOpenTimer).toBeUndefined();
      expect(invalidationListener.mock.calls).toEqual([
        [0, 'replay'],
        [1, 'hydrate'],
      ]);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      deferredService.dispose();
    }
  });

  it('does not emit hydrate when a fresh store mutation invalidates incremental hydration', async () => {
    const query = 'store-mutation-race';
    const scope = {
      query: `${query} gguf`,
      cursor: null,
      pageSize: 20,
      sort: null,
      authScope: 'anon' as const,
    };
    const seedCache = new ModelCatalogCacheStore();
    seedCache.putSearch(scope, {
      models: ['a', 'b', 'c', 'd', 'e'].map((suffix) => makeLocalModel(`org/stale-${suffix}`)),
      hasMore: false,
      nextCursor: null,
    });
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const persistentCache = (deferredService as unknown as {
      persistentCache: ModelCatalogCacheStore;
    }).persistentCache;
    const invalidationListener = jest.fn();
    deferredService.subscribeCacheInvalidations(invalidationListener);
    jest.useFakeTimers();

    try {
      const incrementalAttempt = deferredService.hydratePersistentCacheIncrementally();
      persistentCache.putSearch(scope, {
        models: [makeLocalModel('org/fresh-after-mutation')],
        hasMore: false,
        nextCursor: null,
      });
      await jest.runAllTimersAsync();
      await incrementalAttempt;

      expect(invalidationListener.mock.calls).toEqual([[0, 'replay']]);
      expect(persistentCache.getSearch(scope, Number.POSITIVE_INFINITY)?.models.map((model) => model.id)).toEqual([
        'org/fresh-after-mutation',
      ]);
    } finally {
      deferredService.dispose();
      jest.useRealTimers();
    }
  });

  it('cancels model details before fetch when a manual clear wins the memory-context race', async () => {
    const service = new ModelCatalogService();
    const memory = createDeferred<number>();
    (DeviceInfo.getTotalMemory as jest.Mock).mockReturnValue(memory.promise);
    global.fetch = jest.fn();

    try {
      const pendingDetails = service.getModelDetails('org/details-clear-race');
      await waitForMockCallCount(DeviceInfo.getTotalMemory as jest.Mock, 1);

      service.clearCache('manual');
      memory.resolve(8 * 1024 * 1024 * 1024);

      await expect(pendingDetails).rejects.toMatchObject({ code: 'cancelled' });
      expect(global.fetch).not.toHaveBeenCalled();
      expect((service as unknown as { lastMemoryFitContext: unknown }).lastMemoryFitContext).toBeNull();
      expect(new ModelCatalogCacheStore().getModelSnapshot(
        'org/details-clear-race',
        'anon',
        Number.POSITIVE_INFINITY,
      )).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it('does not repopulate snapshots when a manual clear wins a local-model read race', async () => {
    const localModel = makeLocalModel('org/local-clear-race');
    mockedRegistry.getModels.mockReturnValue([localModel]);
    mockedRegistry.getModel.mockImplementation((modelId) => (
      modelId === localModel.id ? localModel : undefined
    ));
    const service = new ModelCatalogService();
    const memory = createDeferred<number>();
    (DeviceInfo.getTotalMemory as jest.Mock).mockReturnValue(memory.promise);

    try {
      const pendingModels = service.getLocalModels();
      await waitForMockCallCount(DeviceInfo.getTotalMemory as jest.Mock, 1);

      service.clearCache('manual');
      memory.resolve(8 * 1024 * 1024 * 1024);

      await expect(pendingModels).resolves.toEqual([expect.objectContaining({ id: localModel.id })]);
      expect((service as unknown as { modelSnapshotCache: Map<string, ModelMetadata> }).modelSnapshotCache)
        .toHaveProperty('size', 0);
      expect((service as unknown as { lastMemoryFitContext: unknown }).lastMemoryFitContext).toBeNull();
      expect(new ModelCatalogCacheStore().getModelSnapshot(
        localModel.id,
        'anon',
        Number.POSITIVE_INFINITY,
      )).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it('uses one shared fail-open timeout and still allows a later explicit hydration', async () => {
    const cachedModel: ModelMetadata = {
      ...makeLocalModel('org/late-hydration-model'),
      description: 'Loaded after the shared wait timed out',
    };
    const seedCache = new ModelCatalogCacheStore();
    seedCache.putModelSnapshots([cachedModel], 'anon');
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const invalidationListener = jest.fn();
    deferredService.subscribeCacheInvalidations(invalidationListener);
    const waitForHydrationAttempt = (
      deferredService as unknown as {
        waitForPersistentCacheHydrationAttempt: () => Promise<void>;
      }
    ).waitForPersistentCacheHydrationAttempt.bind(deferredService);
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    try {
      let didFirstWaitSettle = false;
      const firstWait = waitForHydrationAttempt().then(() => {
        didFirstWaitSettle = true;
      });
      await Promise.resolve();

      expect(didFirstWaitSettle).toBe(false);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(999);
      await Promise.resolve();
      expect(didFirstWaitSettle).toBe(false);

      jest.advanceTimersByTime(1);
      await firstWait;
      expect(didFirstWaitSettle).toBe(true);

      await expect(waitForHydrationAttempt()).resolves.toBeUndefined();
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

      deferredService.hydratePersistentCache();

      expect(deferredService.getCachedModel(cachedModel.id)).toEqual(expect.objectContaining({
        id: cachedModel.id,
        description: cachedModel.description,
      }));
      expect(invalidationListener).toHaveBeenLastCalledWith(1, 'hydrate');
    } finally {
      deferredService.dispose();
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('hydrates a deferred model snapshot before an offline details failure is exposed', async () => {
    const cachedModel = makeLocalModel('org/offline-details-model');
    const seedCache = new ModelCatalogCacheStore();
    seedCache.putModelSnapshots([cachedModel], 'anon');
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    let didSettle = false;

    const pendingDetails = deferredService.getModelDetails(cachedModel.id).finally(() => {
      didSettle = true;
    });
    await Promise.resolve();

    expect(didSettle).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();

    deferredService.hydratePersistentCache();

    await expect(pendingDetails).rejects.toThrow('offline');
    expect(deferredService.getCachedModel(cachedModel.id)?.id).toBe(cachedModel.id);
    deferredService.dispose();
  });

  it('hydrates deferred snapshots before merging local models and preserves cached metadata', async () => {
    const localModel = makeLocalModel('org/deferred-local-model');
    const cachedModel: ModelMetadata = {
      ...localModel,
      description: 'Persisted catalog description',
      maxContextTokens: 32_768,
      hasVerifiedContextWindow: true,
    };
    const seedCache = new ModelCatalogCacheStore();
    seedCache.putModelSnapshots([cachedModel], 'anon');
    mockedRegistry.getModels.mockReturnValue([localModel]);
    mockedRegistry.getModel.mockImplementation((modelId) => (
      modelId === localModel.id ? localModel : undefined
    ));
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    let didSettle = false;

    try {
      const pendingModels = deferredService.getLocalModels().then((models) => {
        didSettle = true;
        return models;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(didSettle).toBe(false);
      expect(mockedRegistry.getModels).not.toHaveBeenCalled();

      deferredService.hydratePersistentCache();
      const models = await pendingModels;

      expect(models).toHaveLength(1);
      expect(models[0]).toEqual(expect.objectContaining({
        id: localModel.id,
        localPath: localModel.localPath,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        description: cachedModel.description,
        maxContextTokens: cachedModel.maxContextTokens,
        hasVerifiedContextWindow: true,
      }));

      const rehydratedStore = new ModelCatalogCacheStore();
      expect(rehydratedStore.getModelSnapshot(localModel.id, 'anon', 1000)).toEqual(
        expect.objectContaining({
          description: cachedModel.description,
          maxContextTokens: cachedModel.maxContextTokens,
          hasVerifiedContextWindow: true,
        }),
      );
    } finally {
      deferredService.dispose();
    }
  });

  it('falls back to registry models when deferred cache hydration fails', async () => {
    const localModel = makeLocalModel('org/deferred-local-cache-failure');
    mockedRegistry.getModels.mockReturnValue([localModel]);
    mockedRegistry.getModel.mockImplementation((modelId) => (
      modelId === localModel.id ? localModel : undefined
    ));
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const persistentCache = (deferredService as unknown as {
      persistentCache: ModelCatalogCacheStore;
    }).persistentCache;
    const storage = (persistentCache as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const getStringSpy = jest.spyOn(storage, 'getString').mockImplementation(() => {
      throw new Error('persistent storage unavailable');
    });

    try {
      const pendingModels = deferredService.getLocalModels();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockedRegistry.getModels).not.toHaveBeenCalled();
      expect(() => deferredService.hydratePersistentCache()).toThrow('persistent storage unavailable');

      await expect(pendingModels).resolves.toEqual([
        expect.objectContaining({ id: localModel.id, localPath: localModel.localPath }),
      ]);
      expect(getStringSpy).toHaveBeenCalledTimes(1);
    } finally {
      getStringSpy.mockRestore();
      deferredService.dispose();
    }
  });

  it('does not overwrite a rich persisted snapshot during offline search after transient hydration failure', async () => {
    const localModel = makeLocalModel('org/transient-local-search');
    const cachedModel: ModelMetadata = {
      ...localModel,
      description: 'Rich persisted catalog description',
      maxContextTokens: 65_536,
      hasVerifiedContextWindow: true,
    };
    const seedCache = new ModelCatalogCacheStore();
    seedCache.putModelSnapshots([cachedModel], 'anon');
    mockedRegistry.getModels.mockReturnValue([localModel]);
    mockedRegistry.getModel.mockImplementation((modelId) => (
      modelId === localModel.id ? localModel : undefined
    ));
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const invalidationListener = jest.fn();
    deferredService.subscribeCacheInvalidations(invalidationListener);
    const persistentCache = (deferredService as unknown as {
      persistentCache: ModelCatalogCacheStore;
    }).persistentCache;
    const storage = (persistentCache as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const originalGetString = storage.getString.bind(storage);
    const getStringSpy = jest.spyOn(storage, 'getString')
      .mockImplementationOnce(() => {
        throw new Error('transient persistent storage failure');
      })
      .mockImplementation((key) => originalGetString(key));
    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: false });
    global.fetch = jest.fn();

    try {
      expect(() => deferredService.hydratePersistentCache()).toThrow('transient persistent storage failure');

      const result = await deferredService.searchModels('transient-local-search');

      expect(result.models).toEqual([
        expect.objectContaining({ id: localModel.id, localPath: localModel.localPath }),
      ]);
      expect(global.fetch).not.toHaveBeenCalled();

      const coldReload = new ModelCatalogCacheStore();
      expect(coldReload.getModelSnapshot(localModel.id, 'anon', 1000)).toEqual(expect.objectContaining({
        description: cachedModel.description,
        maxContextTokens: cachedModel.maxContextTokens,
        hasVerifiedContextWindow: true,
      }));

      deferredService.hydratePersistentCache();
      expect(invalidationListener).toHaveBeenLastCalledWith(1, 'hydrate');
    } finally {
      getStringSpy.mockRestore();
      deferredService.dispose();
    }
  });

  it('returns a successful network search after deferred persistent hydration fails', async () => {
    const modelId = 'org/cache-fail-open-model';
    const deferredService = new ModelCatalogService({ hydratePersistentCacheOnCreate: false });
    const persistentCache = (deferredService as unknown as {
      persistentCache: ModelCatalogCacheStore;
    }).persistentCache;
    const storage = (persistentCache as unknown as {
      storage: ReturnType<typeof createStorage>;
    }).storage;
    const getStringSpy = jest.spyOn(storage, 'getString').mockImplementation(() => {
      throw new Error('persistent storage unavailable');
    });
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve([makeRepo(modelId)]),
    })) as jest.Mock;

    try {
      expect(() => deferredService.hydratePersistentCache()).toThrow('persistent storage unavailable');

      const result = await deferredService.searchModels('cache fail open');

      expect(result.models.map((model) => model.id)).toEqual([modelId]);
      expect(global.fetch).toHaveBeenCalled();
    } finally {
      getStringSpy.mockRestore();
      deferredService.dispose();
    }
  });

  it('filters models based on hardware constraints', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * 1024 * 1024 * 1024);

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/small-model', 1_000_000_000)]),
      }),
    ) as jest.Mock;

    const available = await modelCatalogService.searchModels();

    expect(available.models).toHaveLength(1);
    expect(available.models[0].id).toBe('org/small-model');
    expect(available.models[0].fitsInRam).toBe(true);
    expect(available.hasMore).toBe(false);
  });

  it('uses the device total-memory budget for catalog RAM badges and cached results', async () => {
    (getSystemMemorySnapshot as jest.Mock).mockResolvedValue({
      totalBytes: 8 * 1024 * 1024 * 1024,
      availableBytes: 2_000_000_000,
      freeBytes: 1_500_000_000,
      usedBytes: 0,
      appUsedBytes: 0,
      lowMemory: false,
      thresholdBytes: 200_000_000,
    });

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/live-memory-model', 1.3 * 1024 * 1024 * 1024)]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');
    const cachedResult = modelCatalogService.getCachedSearchResult('phi');
    const coldStartService = new ModelCatalogService();
    const coldStartCachedResult = coldStartService.getCachedSearchResult('phi');

    expect(result.models[0].fitsInRam).toBe(true);
    expect(cachedResult?.models[0].fitsInRam).toBe(true);
    expect(coldStartCachedResult?.models[0].fitsInRam).toBe(true);

    coldStartService.dispose();
  });

  it('sanitizes stale projector filenames from in-memory cached search results', async () => {
    const service = new ModelCatalogService();
    const staleModel = makeStaleProjectorCacheModel('org/projector-cache-model');
    const cacheKey = (service as any).buildMemorySearchCacheKey('gguf', null, 20, null, false, undefined);
    (service as any).searchCache.set(cacheKey, {
      result: {
        models: [staleModel],
        hasMore: false,
        nextCursor: null,
      },
      timestamp: Date.now(),
      isBufferedCursor: false,
    });
    global.fetch = jest.fn() as jest.Mock;

    const result = await service.searchModels();
    const model = result.models[0];

    expect(global.fetch).not.toHaveBeenCalled();
    expect(model.id).toBe(staleModel.id);
    expect(model.resolvedFileName).toBeUndefined();
    expect(model.sha256).toBeUndefined();
    expect(model.requiresTreeProbe).toBe(true);
    expect(model.downloadUrl).not.toContain('mmproj');

    service.dispose();
  });

  it('clears stale file metadata when a valid resolved filename has a projector download URL', async () => {
    const staleModel: ModelMetadata = {
      ...makeStaleProjectorCacheModel('org/mismatched-projector-url-cache-model'),
      resolvedFileName: 'model.Q4_K_M.gguf',
      metadataTrust: 'trusted_remote',
      gguf: { totalBytes: 96 * 1024 * 1024, architecture: 'clip' },
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      fitsInRam: true,
    };
    const service = new ModelCatalogService();
    const cacheKey = (service as any).buildMemorySearchCacheKey('gguf', null, 20, null, false, undefined);
    (service as any).searchCache.set(cacheKey, {
      result: {
        models: [staleModel],
        hasMore: false,
        nextCursor: null,
      },
      timestamp: Date.now(),
      isBufferedCursor: false,
    });

    const result = await service.searchModels();
    const model = result.models[0];

    expect(model.resolvedFileName).toBe('model.Q4_K_M.gguf');
    expect(model.downloadUrl).toContain('model.Q4_K_M.gguf');
    expect(model.downloadUrl).not.toContain('mmproj');
    expect(model.size).toBeNull();
    expect(model.sha256).toBeUndefined();
    expect(model.gguf).toBeUndefined();
    expect(model.metadataTrust).toBeUndefined();
    expect(model.memoryFitDecision).toBeUndefined();
    expect(model.requiresTreeProbe).toBe(true);

    service.dispose();
  });

  it('sanitizes stale projector filenames from persisted search and snapshot caches', async () => {
    const staleModel: ModelMetadata = {
      ...makeStaleProjectorCacheModel('org/persisted-projector-cache-model'),
      resolvedFileName: undefined,
    };
    const seedService = new ModelCatalogService();
    (seedService as any).persistentCache.putSearch(
      (seedService as any).buildPersistentSearchScope('gguf', 20, null, false),
      {
        models: [staleModel],
        hasMore: false,
        nextCursor: null,
      },
    );
    (seedService as any).persistentCache.putModelSnapshots([staleModel], 'anon');
    seedService.dispose();

    const coldStartService = new ModelCatalogService();
    const cachedSearch = coldStartService.getCachedSearchResult('gguf');
    const cachedSnapshot = coldStartService.getCachedModel(staleModel.id);

    expect(cachedSearch?.models[0]).toEqual(expect.objectContaining({
      id: staleModel.id,
      resolvedFileName: undefined,
      sha256: undefined,
      requiresTreeProbe: true,
    }));
    expect(cachedSearch?.models[0].downloadUrl).not.toContain('mmproj');
    expect(cachedSnapshot).toEqual(expect.objectContaining({
      id: staleModel.id,
      resolvedFileName: undefined,
      sha256: undefined,
      requiresTreeProbe: true,
    }));
    expect(cachedSnapshot?.downloadUrl).not.toContain('mmproj');

    coldStartService.dispose();
  });

  it('uses valid local file metadata instead of stale projector cache metadata', async () => {
    const staleModel = makeStaleProjectorCacheModel('org/local-fallback-projector-cache-model');
    const localModel: ModelMetadata = {
      ...makeLocalModel(staleModel.id),
      size: 4 * 1024 * 1024 * 1024,
      hfRevision: 'new-local-revision',
      metadataTrust: 'verified_local',
      gguf: { totalBytes: 4 * 1024 * 1024 * 1024, architecture: 'llama' },
      resolvedFileName: 'model.Q4_K_M.gguf',
      downloadUrl: `https://huggingface.co/${staleModel.id}/resolve/new-local-revision/model.Q4_K_M.gguf`,
      sha256: LOCAL_SHA256,
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
    };
    staleModel.hfRevision = 'old-projector-revision';
    mockedRegistry.getModel.mockReturnValue(localModel);

    const service = new ModelCatalogService();
    const cacheKey = (service as any).buildMemorySearchCacheKey('gguf', null, 20, null, false, undefined);
    (service as any).searchCache.set(cacheKey, {
      result: {
        models: [staleModel],
        hasMore: false,
        nextCursor: null,
      },
      timestamp: Date.now(),
      isBufferedCursor: false,
    });

    const result = await service.searchModels();
    const model = result.models[0];

    expect(model.resolvedFileName).toBe(localModel.resolvedFileName);
    expect(model.downloadUrl).toContain('model.Q4_K_M.gguf');
    expect(model.downloadUrl).toContain('new-local-revision');
    expect(model.downloadUrl).not.toContain('mmproj');
    expect(model.size).toBe(localModel.size);
    expect(model.metadataTrust).toBe('verified_local');
    expect(model.gguf?.totalBytes).toBe(localModel.gguf?.totalBytes);
    expect(model.sha256).toBe(localModel.sha256);

    service.dispose();
  });

  it('does not reuse a stale projector revision when the valid local fallback uses the default revision', async () => {
    const staleModel = makeStaleProjectorCacheModel('org/local-main-fallback-projector-cache-model');
    staleModel.hfRevision = 'old-projector-revision';
    const localModel: ModelMetadata = {
      ...makeLocalModel(staleModel.id),
      resolvedFileName: 'model.Q4_K_M.gguf',
      downloadUrl: `https://huggingface.co/${staleModel.id}/resolve/main/model.Q4_K_M.gguf`,
      sha256: LOCAL_SHA256,
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      metadataTrust: 'verified_local',
    };
    mockedRegistry.getModel.mockReturnValue(localModel);

    const service = new ModelCatalogService();
    const cacheKey = (service as any).buildMemorySearchCacheKey('gguf', null, 20, null, false, undefined);
    (service as any).searchCache.set(cacheKey, {
      result: {
        models: [staleModel],
        hasMore: false,
        nextCursor: null,
      },
      timestamp: Date.now(),
      isBufferedCursor: false,
    });

    const result = await service.searchModels();
    const model = result.models[0];

    expect(model.resolvedFileName).toBe(localModel.resolvedFileName);
    expect(model.downloadUrl).toContain('/resolve/main/model.Q4_K_M.gguf');
    expect(model.downloadUrl).not.toContain('old-projector-revision');
    expect(model.sha256).toBe(localModel.sha256);

    service.dispose();
  });

  it('does not preemptively warn on borderline GGUF models when only summary metadata is available', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8_000_000_000);

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{
          ...makeRepo('org/large-llama-model', 3_784_824_896),
          gguf: {
            architecture: 'llama',
            'llama.block_count': 32,
            'llama.attention.head_count': 32,
            'llama.attention.head_count_kv': 32,
            'llama.embedding_length': 4096,
          },
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('llama');

    expect(result.models[0].fitsInRam).toBe(true);
    expect(['fits_high_confidence', 'fits_low_confidence']).toContain(result.models[0].memoryFitDecision);
  });

  it('treats ~3.4 GB GGUF models as loadable on 8 GB devices in summary estimates', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8_000_000_000);

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{
          ...makeRepo('org/firefly-class-model', 3_427_874_240),
          gguf: {
            architecture: 'gemma4',
            'gemma4.block_count': 32,
            'gemma4.attention.head_count': 32,
            'gemma4.attention.head_count_kv': 32,
            'gemma4.embedding_length': 4096,
          },
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('firefly');

    expect(result.models[0].fitsInRam).toBe(true);
    expect(['fits_high_confidence', 'fits_low_confidence']).toContain(result.models[0].memoryFitDecision);
  });

  it('appends gguf to search queries', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/phi-model')]),
      }),
    ) as jest.Mock;

    await modelCatalogService.searchModels('phi');

    const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(firstUrl).toContain('search=phi%20gguf');
  });

  it('adds gated=false to Hugging Face search requests when requested', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/phi-model')]),
      }),
    ) as jest.Mock;

    await modelCatalogService.searchModels('phi', { gated: false });

    const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(firstUrl).toContain('gated=false');
  });

  it('returns deferred catalog summaries before tree metadata and updates the cache in the background', async () => {
    const treeResponse = createDeferred<any>();
    const service = new ModelCatalogService();
    const metadataListener = jest.fn();
    const startSpanSpy = jest.spyOn(performanceMonitor, 'startSpan');
    service.subscribeMetadataUpdates(metadataListener);
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tree/main?recursive=true')) {
        return treeResponse.promise;
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/deferred-catalog-model')]),
      });
    }) as jest.Mock;

    try {
      const result = await service.searchModels('phi', {
        pageSize: 1,
        gated: false,
        metadataResolution: 'deferred',
      });

      expect(result.models[0]).toEqual(expect.objectContaining({
        id: 'org/deferred-catalog-model',
        size: null,
        requiresTreeProbe: true,
        sizeResolutionState: 'resolving',
      }));
      expect(metadataListener).not.toHaveBeenCalled();
      const firstUrl = String((global.fetch as jest.Mock).mock.calls[0][0]);
      expect(firstUrl).toContain('limit=1');

      const cachedWhileResolving = await service.searchModels('phi', {
        pageSize: 1,
        gated: false,
        metadataResolution: 'deferred',
      });
      expect(cachedWhileResolving.models[0]?.sizeResolutionState).toBe('resolving');
      expect(new ModelCatalogCacheStore().getSearch({
        query: 'phi gguf',
        cursor: null,
        pageSize: 1,
        sort: null,
        authScope: 'anon',
        gated: false,
      }, Number.POSITIVE_INFINITY)).toBeNull();

      await waitForMockCallCount(global.fetch as jest.Mock, 2);
      treeResponse.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([{
          path: 'model.Q4_K_M.gguf',
          size: 2 * 1024 * 1024 * 1024,
          lfs: { oid: `sha256:${TREE_SHA256}` },
        }]),
      });
      await waitForMockCallCount(metadataListener, 1);

      expect(startSpanSpy).toHaveBeenCalledWith('catalog.deferredMetadata.batch', {
        requested: 1,
        batchSize: 4,
      });

      expect(metadataListener).toHaveBeenCalledWith({
        query: 'phi',
        sort: null,
        gated: false,
        models: [expect.objectContaining({
          id: 'org/deferred-catalog-model',
          size: 2 * 1024 * 1024 * 1024,
          requiresTreeProbe: false,
          sizeResolutionState: 'resolved',
        })],
        removedModelIds: [],
      });
      expect(service.getCachedSearchResult('phi', {
        pageSize: 1,
        gated: false,
        metadataResolution: 'deferred',
      })?.models[0]).toEqual(expect.objectContaining({
        size: 2 * 1024 * 1024 * 1024,
        requiresTreeProbe: false,
        sizeResolutionState: 'resolved',
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(new ModelCatalogCacheStore().getSearch({
        query: 'phi gguf',
        cursor: null,
        pageSize: 1,
        sort: null,
        authScope: 'anon',
        gated: false,
      }, Number.POSITIVE_INFINITY)?.models[0]).toEqual(expect.objectContaining({
        id: 'org/deferred-catalog-model',
        size: 2 * 1024 * 1024 * 1024,
      }));
    } finally {
      startSpanSpy.mockRestore();
      service.dispose();
    }
  });

  it('persists deferred search and model snapshots after first paint when no enrichment is needed', async () => {
    const service = new ModelCatalogService();
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([makeRepo('org/deferred-ready-model')]),
    })) as jest.Mock;

    try {
      const result = await service.searchModels('ready', {
        pageSize: 1,
        gated: false,
        metadataResolution: 'deferred',
      });
      const readPersistedSearch = () => new ModelCatalogCacheStore().getSearch({
        query: 'ready gguf',
        cursor: null,
        pageSize: 1,
        sort: null,
        authScope: 'anon',
        gated: false,
      }, Number.POSITIVE_INFINITY);

      expect(result.models[0]).toEqual(expect.objectContaining({
        id: 'org/deferred-ready-model',
        size: 1.5 * 1024 * 1024 * 1024,
      }));
      expect(readPersistedSearch()).toBeNull();
      expect(service.getCachedModel('org/deferred-ready-model')).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readPersistedSearch()?.models[0]).toEqual(expect.objectContaining({
        id: 'org/deferred-ready-model',
      }));
      expect(service.getCachedModel('org/deferred-ready-model')).toEqual(expect.objectContaining({
        id: 'org/deferred-ready-model',
      }));
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });

  it('aborts deferred metadata and refetches the same query after cancellation', async () => {
    const service = new ModelCatalogService();
    const metadataListener = jest.fn();
    const treeAbort = jest.fn();
    service.subscribeMetadataUpdates(metadataListener);
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            treeAbort();
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/cancelled-deferred-model')]),
      });
    }) as jest.Mock;

    try {
      await service.searchModels('cancelled-deferred', {
        pageSize: 1,
        gated: false,
        metadataResolution: 'deferred',
      });
      await waitForMockCallCount(global.fetch as jest.Mock, 2);

      service.cancelPendingSearchRequests();
      await waitForMockCallCount(treeAbort, 1);
      await Promise.resolve();

      expect(metadataListener).not.toHaveBeenCalled();
      expect(new ModelCatalogCacheStore().getSearch({
        query: 'cancelled-deferred gguf',
        cursor: null,
        pageSize: 1,
        sort: null,
        authScope: 'anon',
        gated: false,
      }, Number.POSITIVE_INFINITY)).toBeNull();

      const repeatedResult = await service.searchModels('cancelled-deferred', {
        pageSize: 1,
        gated: false,
        metadataResolution: 'deferred',
      });

      expect(repeatedResult.models[0]).toEqual(expect.objectContaining({
        id: 'org/cancelled-deferred-model',
        sizeResolutionState: 'resolving',
      }));
      expect(global.fetch).toHaveBeenCalledTimes(3);
    } finally {
      service.dispose();
    }
  });

  it('cancels a superseded catalog search instead of leaving it alive in the background', async () => {
    const service = new ModelCatalogService();
    const fetchMock = jest.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    global.fetch = fetchMock as typeof fetch;

    const pendingSearch = service.searchModels('superseded', {
      pageSize: 20,
      metadataResolution: 'deferred',
    });
    await waitForMockCallCount(fetchMock, 1);

    service.cancelPendingSearchRequests();

    await expect(pendingSearch).rejects.toMatchObject({
      name: 'ModelCatalogError',
      code: 'cancelled',
    });
    service.dispose();
  });

  it('does not abort an independent catalog search when another consumer cancels', async () => {
    const service = new ModelCatalogService();
    const sessionA = service.createSearchSession();
    const sessionB = service.createSearchSession();
    const requestA = createDeferred<Response>();
    const requestB = createDeferred<Response>();
    const abortA = jest.fn(() => requestA.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    const abortB = jest.fn(() => requestB.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const isConsumerA = String(input).includes('search=consumer-a');
      init?.signal?.addEventListener('abort', isConsumerA ? abortA : abortB, { once: true });
      return isConsumerA ? requestA.promise : requestB.promise;
    }) as jest.Mock;

    const pendingA = service.searchModels('consumer-a', {
      pageSize: 1,
      metadataResolution: 'deferred',
    }, sessionA);
    const pendingB = service.searchModels('consumer-b', {
      pageSize: 1,
      metadataResolution: 'deferred',
    }, sessionB);
    const handledA = pendingA.catch(() => undefined);
    const handledB = pendingB.catch(() => undefined);
    await waitForMockCallCount(global.fetch as jest.Mock, 2);

    sessionA.cancelPendingRequests('superseded');
    await Promise.resolve();

    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).not.toHaveBeenCalled();

    requestB.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([makeRepo('org/consumer-b-model')]),
    } as unknown as Response);
    await Promise.all([handledA, handledB]);
    sessionA.dispose();
    sessionB.dispose();
    service.dispose();
  });

  it('emits bounded catalog ownership telemetry without request URLs', async () => {
    const service = new ModelCatalogService();
    const session = service.createSearchSession();
    const startSpanSpy = jest.spyOn(performanceMonitor, 'startSpan');
    const incrementCounterSpy = jest.spyOn(performanceMonitor, 'incrementCounter');
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([makeRepo('org/telemetry-model')]),
    })) as jest.Mock;

    try {
      await service.searchModels('telemetry-private-query', {
        pageSize: 1,
        metadataResolution: 'deferred',
      }, session);
      session.cancelPendingRequests('superseded');

      expect(startSpanSpy).toHaveBeenCalledWith('catalog.search.session', expect.objectContaining({
        sessionId: expect.any(Number),
        generation: expect.any(Number),
        pageSize: 1,
      }));
      const resourceRequestCall = incrementCounterSpy.mock.calls.find(([name]) => (
        name === 'catalog.resource.request'
      ));
      expect(resourceRequestCall).toEqual([
        'catalog.resource.request',
        1,
        expect.objectContaining({
          scope: 'search',
          authScope: 'anon',
          activeRequests: expect.any(Number),
        }),
      ]);
      expect(JSON.stringify(resourceRequestCall?.[2])).not.toContain('telemetry-private-query');
      expect(JSON.stringify(resourceRequestCall?.[2])).not.toContain('huggingface.co');
      expect(incrementCounterSpy).toHaveBeenCalledWith(
        'catalog.search.cancel',
        1,
        { reason: 'superseded' },
      );
    } finally {
      startSpanSpy.mockRestore();
      incrementCounterSpy.mockRestore();
      session.dispose();
      service.dispose();
    }
  });

  it('keeps model-details work alive when a catalog query session is superseded', async () => {
    const service = new ModelCatalogService();
    const searchSession = service.createSearchSession();
    const searchRequest = createDeferred<Response>();
    const detailsRequest = createDeferred<Response>();
    const searchAbort = jest.fn(() => searchRequest.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    const detailsAbort = jest.fn(() => detailsRequest.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const isDetailsRequest = String(input).includes('details-b');
      init?.signal?.addEventListener('abort', isDetailsRequest ? detailsAbort : searchAbort, { once: true });
      return isDetailsRequest ? detailsRequest.promise : searchRequest.promise;
    }) as jest.Mock;

    const pendingSearch = service.searchModels('query-a', {
      pageSize: 1,
      metadataResolution: 'deferred',
    }, searchSession);
    const pendingDetails = service.getModelDetails('org/details-b');
    const handledSearch = pendingSearch.catch(() => undefined);
    const handledDetails = pendingDetails.catch(() => undefined);
    await waitForMockCallCount(global.fetch as jest.Mock, 2);

    searchSession.cancelPendingRequests('superseded');
    await Promise.resolve();

    expect(searchAbort).toHaveBeenCalledTimes(1);
    expect(detailsAbort).not.toHaveBeenCalled();

    service.clearCache('manual');
    await Promise.all([handledSearch, handledDetails]);
    expect(detailsAbort).toHaveBeenCalledTimes(1);
    searchSession.dispose();
    service.dispose();
  });

  it('removes consumer abort listeners after model-details resources settle', async () => {
    const service = new ModelCatalogService();
    const controller = new AbortController();
    const addListenerSpy = jest.spyOn(controller.signal, 'addEventListener');
    const removeListenerSpy = jest.spyOn(controller.signal, 'removeEventListener');
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeRepo('org/listener-cleanup-model')),
      });
    }) as jest.Mock;

    try {
      await service.getModelDetails('org/listener-cleanup-model', {
        signal: controller.signal,
      });

      const abortListenerAdds = addListenerSpy.mock.calls.filter(([eventName]) => eventName === 'abort').length;
      const abortListenerRemovals = removeListenerSpy.mock.calls.filter(([eventName]) => eventName === 'abort').length;
      expect(abortListenerAdds).toBeGreaterThan(0);
      expect(abortListenerRemovals).toBe(abortListenerAdds);
      await waitForCatalogRequestMapsToSettle(service);
    } finally {
      addListenerSpy.mockRestore();
      removeListenerSpy.mockRestore();
      service.dispose();
    }
  });

  it('manual cache clear cancels every search owner and blocks stale cache repopulation', async () => {
    const service = new ModelCatalogService();
    const sessionA = service.createSearchSession();
    const sessionB = service.createSearchSession();
    const requestA = createDeferred<Response>();
    const requestB = createDeferred<Response>();
    const abortA = jest.fn();
    const abortB = jest.fn();
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const isConsumerA = String(input).includes('manual-a');
      init?.signal?.addEventListener('abort', isConsumerA ? abortA : abortB, { once: true });
      return isConsumerA ? requestA.promise : requestB.promise;
    }) as jest.Mock;

    const pendingA = service.searchModels('manual-a', {
      pageSize: 1,
      metadataResolution: 'deferred',
    }, sessionA);
    const pendingB = service.searchModels('manual-b', {
      pageSize: 1,
      metadataResolution: 'deferred',
    }, sessionB);
    const handledA = pendingA.catch(() => undefined);
    const handledB = pendingB.catch(() => undefined);
    await waitForMockCallCount(global.fetch as jest.Mock, 2);

    service.clearCache('manual');
    await Promise.all([handledA, handledB]);

    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);

    const response = (id: string) => ({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([makeRepo(id)]),
    } as unknown as Response);
    requestA.resolve(response('org/stale-manual-a'));
    requestB.resolve(response('org/stale-manual-b'));
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getCachedSearchResult('manual-a', {
      pageSize: 1,
      metadataResolution: 'deferred',
    })).toBeNull();
    expect(service.getCachedSearchResult('manual-b', {
      pageSize: 1,
      metadataResolution: 'deferred',
    })).toBeNull();
    await waitForCatalogRequestMapsToSettle(service);
    sessionA.dispose();
    sessionB.dispose();
    service.dispose();
  });

  it('shares deferred resource work until the last search consumer detaches', async () => {
    const service = new ModelCatalogService();
    const sessionA = service.createSearchSession();
    const sessionB = service.createSearchSession();
    const metadataListener = jest.fn();
    const treeRequest = createDeferred<Response>();
    const treeAbort = jest.fn(() => treeRequest.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    service.subscribeMetadataUpdates(metadataListener);
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        init?.signal?.addEventListener('abort', treeAbort, { once: true });
        return treeRequest.promise;
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/shared-deferred-model')]),
      });
    }) as jest.Mock;

    await service.searchModels('shared-deferred', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionA);
    await waitForMockCallCount(global.fetch as jest.Mock, 2);

    await service.searchModels('shared-deferred', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionB);
    expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => (
      String(url).includes('/tree/main?recursive=true')
    ))).toHaveLength(1);

    sessionA.cancelPendingRequests('unmount');
    await Promise.resolve();
    expect(treeAbort).not.toHaveBeenCalled();

    sessionB.cancelPendingRequests('unmount');
    await waitForMockCallCount(treeAbort, 1);
    await waitForCatalogRequestMapsToSettle(service);

    expect(metadataListener).not.toHaveBeenCalled();
    expect(service.getCachedSearchResult('shared-deferred', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    })).toBeNull();
    sessionA.dispose();
    sessionB.dispose();
    service.dispose();
  });

  it('finishes shared deferred metadata when the first search consumer detaches', async () => {
    const service = new ModelCatalogService();
    const sessionA = service.createSearchSession();
    const sessionB = service.createSearchSession();
    const metadataListener = jest.fn();
    const treeRequest = createDeferred<Response>();
    const treeAbort = jest.fn();
    service.subscribeMetadataUpdates(metadataListener);
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        init?.signal?.addEventListener('abort', treeAbort, { once: true });
        return treeRequest.promise;
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/shared-deferred-survivor')]),
      });
    }) as jest.Mock;

    await service.searchModels('shared-deferred-survivor', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionA);
    await waitForMockCallCount(global.fetch as jest.Mock, 2);

    await service.searchModels('shared-deferred-survivor', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionB);
    sessionA.cancelPendingRequests('unmount');
    await Promise.resolve();
    expect(treeAbort).not.toHaveBeenCalled();

    treeRequest.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([{
        path: 'model.Q4_K_M.gguf',
        size: 2 * 1024 * 1024 * 1024,
        lfs: { oid: `sha256:${TREE_SHA256}` },
      }]),
    } as unknown as Response);
    await waitForMockCallCount(metadataListener, 1);

    expect(treeAbort).not.toHaveBeenCalled();
    expect((global.fetch as jest.Mock).mock.calls.filter(([url]) => (
      String(url).includes('/tree/main?recursive=true')
    ))).toHaveLength(1);
    expect(metadataListener).toHaveBeenCalledWith(expect.objectContaining({
      query: 'shared-deferred-survivor',
      models: [expect.objectContaining({
        id: 'org/shared-deferred-survivor',
        size: 2 * 1024 * 1024 * 1024,
        requiresTreeProbe: false,
        sizeResolutionState: 'resolved',
      })],
    }));
    expect(service.getCachedSearchResult('shared-deferred-survivor', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    })?.models[0]).toEqual(expect.objectContaining({
      size: 2 * 1024 * 1024 * 1024,
      requiresTreeProbe: false,
      sizeResolutionState: 'resolved',
    }));
    await waitForCatalogRequestMapsToSettle(service);
    sessionA.dispose();
    sessionB.dispose();
    service.dispose();
  });

  it('evicts deferred cache state when its only owner cancels before enrichment starts', async () => {
    const service = new ModelCatalogService();
    const sessionA = service.createSearchSession();
    const sessionB = service.createSearchSession();
    let listRequestCount = 0;
    let treeRequestCount = 0;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        treeRequestCount += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          json: () => Promise.resolve([]),
        });
      }

      listRequestCount += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/pre-enrichment-cancel')]),
      });
    }) as jest.Mock;

    await service.searchModels('pre-enrichment-cancel', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionA);
    sessionA.cancelPendingRequests('unmount');
    await waitForCatalogRequestMapsToSettle(service);

    expect(treeRequestCount).toBe(0);
    expect(service.getCachedSearchResult('pre-enrichment-cancel', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    })).toBeNull();

    await service.searchModels('pre-enrichment-cancel', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionB);
    expect(listRequestCount).toBe(2);
    sessionA.dispose();
    sessionB.dispose();
    service.dispose();
  });

  it('evicts shared deferred cache when every owner cancels before enrichment starts', async () => {
    const service = new ModelCatalogService();
    const sessionA = service.createSearchSession();
    const sessionB = service.createSearchSession();
    let listRequestCount = 0;
    let treeRequestCount = 0;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        treeRequestCount += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          json: () => Promise.resolve([]),
        });
      }

      listRequestCount += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/shared-pre-enrichment-cancel')]),
      });
    }) as jest.Mock;

    await service.searchModels('shared-pre-enrichment-cancel', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionA);
    await service.searchModels('shared-pre-enrichment-cancel', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionB);

    sessionA.cancelPendingRequests('unmount');
    sessionB.cancelPendingRequests('unmount');
    await waitForCatalogRequestMapsToSettle(service);

    expect(treeRequestCount).toBe(0);
    expect(service.getCachedSearchResult('shared-pre-enrichment-cancel', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    })).toBeNull();

    await service.searchModels('shared-pre-enrichment-cancel', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionB);
    expect(listRequestCount).toBe(2);
    sessionA.dispose();
    sessionB.dispose();
    service.dispose();
  });

  it('refetches immediately instead of joining an aborted deferred request', async () => {
    const service = new ModelCatalogService();
    const sessionA = service.createSearchSession();
    const sessionB = service.createSearchSession();
    const replacementSession = service.createSearchSession();
    const metadataListener = jest.fn();
    let listRequestCount = 0;
    let treeRequestCount = 0;
    service.subscribeMetadataUpdates(metadataListener);
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        treeRequestCount += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          json: () => Promise.resolve([{
            path: 'model.Q4_K_M.gguf',
            size: 2 * 1024 * 1024 * 1024,
            lfs: { oid: `sha256:${TREE_SHA256}` },
          }]),
        });
      }

      listRequestCount += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/immediate-deferred-replacement')]),
      });
    }) as jest.Mock;

    await service.searchModels('immediate-deferred-replacement', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionA);
    await service.searchModels('immediate-deferred-replacement', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, sessionB);
    sessionA.cancelPendingRequests('unmount');
    sessionB.cancelPendingRequests('unmount');

    const replacementResult = await service.searchModels('immediate-deferred-replacement', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    }, replacementSession);

    expect(listRequestCount).toBe(2);
    expect(replacementResult.models[0]).toEqual(expect.objectContaining({
      id: 'org/immediate-deferred-replacement',
      sizeResolutionState: 'resolving',
    }));
    await waitForMockCallCount(metadataListener, 1);
    expect(treeRequestCount).toBe(1);
    expect(service.getCachedSearchResult('immediate-deferred-replacement', {
      pageSize: 1,
      gated: false,
      metadataResolution: 'deferred',
    })?.models[0]).toEqual(expect.objectContaining({
      size: 2 * 1024 * 1024 * 1024,
      requiresTreeProbe: false,
      sizeResolutionState: 'resolved',
    }));
    await waitForCatalogRequestMapsToSettle(service);
    sessionA.dispose();
    sessionB.dispose();
    replacementSession.dispose();
    service.dispose();
  });

  it('cancels only auth-incompatible work when the token epoch changes', async () => {
    const service = new ModelCatalogService();
    const anonymousSession = service.createSearchSession();
    const authenticatedSession = service.createSearchSession();
    const anonymousRequest = createDeferred<Response>();
    const firstAuthenticatedRequest = createDeferred<Response>();
    const anonymousAbort = jest.fn(() => anonymousRequest.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    const authenticatedAbort = jest.fn(() => firstAuthenticatedRequest.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    let authenticatedRequestCount = 0;
    global.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (!authorization) {
        init?.signal?.addEventListener('abort', anonymousAbort, { once: true });
        return anonymousRequest.promise;
      }

      authenticatedRequestCount += 1;
      if (authenticatedRequestCount === 1) {
        init?.signal?.addEventListener('abort', authenticatedAbort, { once: true });
        return firstAuthenticatedRequest.promise;
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepo('org/fresh-auth-epoch')]),
      });
    }) as jest.Mock;

    const pendingAnonymous = service.searchModels('anonymous-epoch', {
      pageSize: 1,
      metadataResolution: 'deferred',
    }, anonymousSession);
    await waitForMockCallCount(global.fetch as jest.Mock, 1);

    await huggingFaceTokenService.saveToken('hf_token_a');
    expect(anonymousAbort).not.toHaveBeenCalled();

    const pendingAuthenticated = service.searchModels('authenticated-epoch', {
      pageSize: 1,
      metadataResolution: 'deferred',
    }, authenticatedSession);
    await waitForMockCallCount(global.fetch as jest.Mock, 2);

    await huggingFaceTokenService.saveToken('hf_token_b');
    await waitForMockCallCount(authenticatedAbort, 1);
    expect(anonymousAbort).not.toHaveBeenCalled();

    anonymousRequest.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([makeRepo('org/compatible-anonymous-epoch')]),
    } as unknown as Response);

    await expect(pendingAnonymous).resolves.toEqual(expect.objectContaining({
      models: [expect.objectContaining({ id: 'org/compatible-anonymous-epoch' })],
    }));
    await expect(pendingAuthenticated).resolves.toEqual(expect.objectContaining({
      models: [expect.objectContaining({ id: 'org/fresh-auth-epoch' })],
    }));
    expect(authenticatedRequestCount).toBe(2);
    anonymousSession.dispose();
    authenticatedSession.dispose();
    service.dispose();
  });

  it('bounds atomic snapshot retries and never synthesizes a token/revision pair', async () => {
    const service = new ModelCatalogService();
    const staleRevision = huggingFaceTokenService.getCachedRevision() + 1;
    const snapshotSpy = jest.spyOn(huggingFaceTokenService, 'getSnapshot').mockResolvedValue({
      token: 'hf_uncommitted_token',
      revision: staleRevision,
    });
    global.fetch = jest.fn();

    try {
      await expect(service.searchModels('snapshot-exhaustion')).rejects.toMatchObject({
        code: 'network',
        message: 'Catalog auth context changed during request',
      });
      expect(snapshotSpy).toHaveBeenCalledTimes(12);
      expect(global.fetch).not.toHaveBeenCalled();
      expect((service as any).searchCache.size).toBe(0);
    } finally {
      snapshotSpy.mockRestore();
      service.dispose();
    }
  });

  it('retries authenticated search anonymously after token removal without keeping stale auth results', async () => {
    await huggingFaceTokenService.saveToken('hf_token_to_remove');
    const service = new ModelCatalogService();
    const firstRequest = createDeferred<Response>();
    let requestCount = 0;
    global.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
          void firstRequest.promise.then(resolve, reject);
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepo('org/fresh-anonymous-after-removal')]),
      });
    }) as jest.Mock;

    const pendingSearch = service.searchModels('token-removal', {
      pageSize: 1,
      metadataResolution: 'deferred',
    });
    await waitForMockCallCount(global.fetch as jest.Mock, 1);
    await huggingFaceTokenService.clearToken();
    firstRequest.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([makeGatedRepo('org/stale-private-auth-result')]),
    } as unknown as Response);

    await expect(pendingSearch).resolves.toEqual(expect.objectContaining({
      models: [expect.objectContaining({ id: 'org/fresh-anonymous-after-removal' })],
    }));
    const searchCache = (service as any).searchCache as Map<string, {
      result: { models: ModelMetadata[] };
    }>;
    expect(Array.from(searchCache.keys()).every((key) => key.startsWith('anon::'))).toBe(true);
    expect(Array.from(searchCache.values()).flatMap((entry) => entry.result.models).map(
      (model) => model.id,
    )).not.toContain('org/stale-private-auth-result');
    await waitForCatalogRequestMapsToSettle(service);
    service.dispose();
  });

  it('revalidates auth after memory-fit awaits instead of returning an invalidated cached object', async () => {
    await huggingFaceTokenService.saveToken('hf_memory_token_a');
    const service = new ModelCatalogService();
    const memoryRead = createDeferred<number>();
    (DeviceInfo.getTotalMemory as jest.Mock)
      .mockImplementationOnce(() => memoryRead.promise)
      .mockResolvedValue(8 * 1024 * 1024 * 1024);
    const query = 'memory-auth-race';
    const normalizedQuery = (service as any).normalizeQuery(query);
    const cacheKey = (service as any).buildMemorySearchCacheKey(
      normalizedQuery,
      null,
      1,
      null,
      true,
      undefined,
      'deferred',
      huggingFaceTokenService.getCachedRevision(),
    );
    (service as any).searchCache.set(cacheKey, {
      result: {
        models: [makeLocalModel('org/stale-memory-cache-model')],
        hasMore: false,
        nextCursor: null,
      },
      timestamp: Date.now(),
      isBufferedCursor: false,
      isReusableFirstPage: true,
      lastAccessSequence: 1,
      requestId: 1,
    });
    global.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as { Authorization?: string } | undefined)?.Authorization).toBe(
        'Bearer hf_memory_token_b',
      );
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepo('org/fresh-memory-cache-model')]),
      });
    }) as jest.Mock;

    const pendingSearch = service.searchModels(query, {
      pageSize: 1,
      metadataResolution: 'deferred',
    });
    await waitForMockCallCount(DeviceInfo.getTotalMemory as jest.Mock, 1);
    await huggingFaceTokenService.saveToken('hf_memory_token_b');
    memoryRead.resolve(8 * 1024 * 1024 * 1024);

    await expect(pendingSearch).resolves.toEqual(expect.objectContaining({
      models: [expect.objectContaining({ id: 'org/fresh-memory-cache-model' })],
    }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((service as any).searchCache.has(cacheKey)).toBe(false);
    await waitForCatalogRequestMapsToSettle(service);
    service.dispose();
  });

  it('aborts stale tree, README, and probe work and cleans every detached consumer', async () => {
    await huggingFaceTokenService.saveToken('hf_resource_token_a');
    const service = new ModelCatalogService();
    global.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      })
    )) as jest.Mock;

    const contextA = await huggingFaceTokenService.getSnapshot();
    const pendingTree = (service as any).fetchHuggingFaceModelTree(
      'org/stale-tree',
      undefined,
      { authToken: contextA.token, hasAuthToken: true, authVersion: contextA.revision },
      REQUEST_AUTH_POLICY.REQUIRED_AUTH,
    );
    await waitForMockCallCount(global.fetch as jest.Mock, 1);
    await huggingFaceTokenService.saveToken('hf_resource_token_b');
    await expect(pendingTree).rejects.toMatchObject({ name: 'StaleCatalogAuthError' });
    await waitForCatalogRequestMapsToSettle(service);

    const contextB = await huggingFaceTokenService.getSnapshot();
    const pendingReadme = (service as any).fetchModelReadmeData(
      'org/stale-readme',
      undefined,
      { authToken: contextB.token, hasAuthToken: true, authVersion: contextB.revision },
    );
    await waitForMockCallCount(global.fetch as jest.Mock, 2);
    await huggingFaceTokenService.saveToken('hf_resource_token_c');
    await expect(pendingReadme).rejects.toMatchObject({ name: 'StaleCatalogAuthError' });
    await waitForCatalogRequestMapsToSettle(service);

    const contextC = await huggingFaceTokenService.getSnapshot();
    const pendingProbe = (service as any).probeResolvedModelAccess(
      {
        id: 'org/stale-probe',
        resolvedFileName: 'model.gguf',
        accessState: ModelAccessState.AUTHORIZED,
        isGated: true,
        isPrivate: false,
      },
      { authToken: contextC.token, hasAuthToken: true, authVersion: contextC.revision },
    );
    await waitForMockCallCount(global.fetch as jest.Mock, 3);
    await huggingFaceTokenService.clearToken();
    await expect(pendingProbe).rejects.toMatchObject({ name: 'StaleCatalogAuthError' });
    await waitForCatalogRequestMapsToSettle(service);

    expect((service as any).resolvedFileProbeStateCache.size).toBe(0);
    service.dispose();
  });

  it('aborts blocking tree enrichment when its catalog search is cancelled', async () => {
    const service = new ModelCatalogService();
    const treeAbort = jest.fn();
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            treeAbort();
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/blocking-cancelled-model')]),
      });
    }) as jest.Mock;

    try {
      const pendingSearch = service.searchModels('blocking-cancelled', { pageSize: 1 });
      await waitForMockCallCount(global.fetch as jest.Mock, 2);

      service.cancelPendingSearchRequests();

      await expect(pendingSearch).rejects.toMatchObject({ code: 'cancelled' });
      expect(treeAbort).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });

  it('falls back after the bounded search timeout without raising a red-screen console error', async () => {
    const service = new ModelCatalogService();
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    global.fetch = jest.fn((...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;
    jest.useFakeTimers();

    try {
      const pendingSearch = service.searchModels('bounded-timeout', {
        pageSize: 20,
        metadataResolution: 'deferred',
      });
      for (let index = 0; index < 100; index += 1) {
        await Promise.resolve();
      }

      expect(global.fetch).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(8_000);

      await expect(pendingSearch).resolves.toEqual(expect.objectContaining({
        models: [],
        warning: expect.objectContaining({ code: 'timeout' }),
      }));
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      consoleErrorSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps the search timeout active while the response body is being read', async () => {
    const service = new ModelCatalogService();
    let requestSignal: AbortSignal | undefined;
    global.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => new Promise(() => undefined),
      });
    }) as jest.Mock;
    jest.useFakeTimers();

    try {
      const pendingSearch = service.searchModels('stalled-body', {
        pageSize: 20,
        metadataResolution: 'deferred',
      });
      for (let index = 0; index < 100; index += 1) {
        await Promise.resolve();
      }

      expect(global.fetch).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(8_000);

      await expect(pendingSearch).resolves.toEqual(expect.objectContaining({
        models: [],
        warning: expect.objectContaining({ code: 'timeout' }),
      }));
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      service.dispose();
      jest.useRealTimers();
    }
  });

  it('rejects an invalid successful search payload without overwriting the persisted fallback', async () => {
    const query = 'invalid-json-shape';
    const cachedModel = makeLocalModel('org/persisted-before-invalid-shape');
    const scope = {
      query: `${query} gguf`,
      cursor: null,
      pageSize: 1,
      sort: null,
      authScope: 'anon' as const,
    };
    new ModelCatalogCacheStore().putSearch(scope, {
      models: [cachedModel],
      hasMore: false,
      nextCursor: null,
    });
    const service = new ModelCatalogService();
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve(null),
    })) as jest.Mock;

    try {
      const result = await service.searchModels(query, { pageSize: 1, forceRefresh: true });

      expect(result.models.map((model) => model.id)).toEqual([cachedModel.id]);
      expect(result.warning).toEqual(expect.objectContaining({ code: 'network' }));
      expect(new ModelCatalogCacheStore().getSearch(scope, Number.POSITIVE_INFINITY)?.models.map(
        (model) => model.id,
      )).toEqual([cachedModel.id]);
    } finally {
      service.dispose();
    }
  });

  it('keeps a deferred model when a successful tree response has an invalid payload shape', async () => {
    const service = new ModelCatalogService();
    const metadataListener = jest.fn();
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    service.subscribeMetadataUpdates(metadataListener);
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          json: () => Promise.resolve({ unexpected: true }),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/invalid-tree-shape')]),
      });
    }) as jest.Mock;

    try {
      await service.searchModels('invalid-tree', {
        pageSize: 1,
        metadataResolution: 'deferred',
      });
      await waitForMockCallCount(metadataListener, 1);

      expect(metadataListener).toHaveBeenCalledWith(expect.objectContaining({
        models: [expect.objectContaining({
          id: 'org/invalid-tree-shape',
          requiresTreeProbe: true,
          sizeResolutionState: 'unavailable',
        })],
        removedModelIds: [],
      }));
      expect(service.getCachedSearchResult('invalid-tree', {
        pageSize: 1,
        metadataResolution: 'deferred',
      })?.models.map((model) => model.id)).toEqual(['org/invalid-tree-shape']);
    } finally {
      service.dispose();
      consoleWarnSpy.mockRestore();
    }
  });

  it('finishes deferred size resolution as unavailable when tree metadata cannot provide a size', async () => {
    const service = new ModelCatalogService();
    const metadataListener = jest.fn();
    service.subscribeMetadataUpdates(metadataListener);
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({ ok: false, status: 404 });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/unavailable-size-model')]),
      });
    }) as jest.Mock;

    try {
      const result = await service.searchModels('missing-size', {
        pageSize: 1,
        gated: false,
        metadataResolution: 'deferred',
      });

      expect(result.models[0]?.sizeResolutionState).toBe('resolving');
      await waitForMockCallCount(metadataListener, 1);

      expect(metadataListener).toHaveBeenCalledWith(expect.objectContaining({
        models: [expect.objectContaining({
          id: 'org/unavailable-size-model',
          size: null,
          sizeResolutionState: 'unavailable',
        })],
      }));
      expect(service.getCachedSearchResult('missing-size', {
        pageSize: 1,
        gated: false,
        metadataResolution: 'deferred',
      })?.models[0]?.sizeResolutionState).toBe('unavailable');
    } finally {
      service.dispose();
    }
  });

  it('does not let a delayed deferred metadata batch overwrite a force-refreshed search', async () => {
    const staleTreeResponse = createDeferred<any>();
    const service = new ModelCatalogService();
    const metadataListener = jest.fn();
    let searchRequestCount = 0;
    service.subscribeMetadataUpdates(metadataListener);
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tree/main?recursive=true')) {
        return staleTreeResponse.promise;
      }

      searchRequestCount += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([
          searchRequestCount === 1
            ? makeRepoWithUnknownSize('org/deferred-refresh-model')
            : makeRepo('org/deferred-refresh-model', 4 * 1024 * 1024 * 1024),
        ]),
      });
    }) as jest.Mock;

    try {
      await service.searchModels('phi', {
        pageSize: 1,
        metadataResolution: 'deferred',
      });
      await waitForMockCallCount(global.fetch as jest.Mock, 2);

      const refreshed = await service.searchModels('phi', {
        pageSize: 1,
        forceRefresh: true,
        metadataResolution: 'deferred',
      });
      expect(refreshed.models[0].size).toBe(4 * 1024 * 1024 * 1024);

      staleTreeResponse.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([{
          path: 'model.Q4_K_M.gguf',
          size: 2 * 1024 * 1024 * 1024,
        }]),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(metadataListener).not.toHaveBeenCalled();
      expect(service.getCachedSearchResult('phi', {
        pageSize: 1,
        metadataResolution: 'deferred',
      })?.models[0].size).toBe(4 * 1024 * 1024 * 1024);
    } finally {
      service.dispose();
    }
  });

  it('persists public-only searches under a cache scope isolated from ungated results', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([makeRepo('org/public-only-cached-model')]),
    })) as jest.Mock;

    const initialResult = await modelCatalogService.searchModels('phi', {
      pageSize: 10,
      gated: false,
    });
    expect(initialResult.models[0].id).toBe('org/public-only-cached-model');

    const coldStartService = new ModelCatalogService();
    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: false });

    try {
      expect(coldStartService.getCachedSearchResult('phi', { pageSize: 10 })).toBeNull();
      const offlineResult = await coldStartService.searchModels('phi', {
        pageSize: 10,
        gated: false,
      });

      expect(offlineResult.models[0].id).toBe('org/public-only-cached-model');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      coldStartService.dispose();
    }
  });

  it('does not reuse cache entries across gated and ungated catalog searches', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/phi-model')]),
      }),
    ) as jest.Mock;

    await modelCatalogService.searchModels('phi', { pageSize: 10 });
    await modelCatalogService.searchModels('phi', { pageSize: 10, gated: false });

    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    const secondUrl = (global.fetch as jest.Mock).mock.calls[1][0] as string;
    expect(firstUrl).not.toContain('gated=');
    expect(secondUrl).toContain('gated=false');
  });

  it('keeps the largest context ceiling from summary config, cardData, and gguf metadata', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/api/models/org/summary-long-context-model')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ...makeRepo('org/summary-long-context-model'),
            config: {
              max_position_embeddings: 8192,
            },
            cardData: {
              context_length: '32768',
            },
            gguf: {
              total: 1.5 * 1024 * 1024 * 1024,
              context_length: 65536,
              architecture: 'llama',
            },
          }),
        });
      }

      return Promise.resolve({
        ok: false,
        status: 404,
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/summary-long-context-model');

    expect(result).toEqual(expect.objectContaining({
      id: 'org/summary-long-context-model',
      maxContextTokens: 65536,
    }));
  });

  it('preserves verified local context ceilings when unverified search results report a smaller value', async () => {
    const remoteSize = 1.5 * 1024 * 1024 * 1024;
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/verified-local-context-model'),
      size: remoteSize,
      resolvedFileName: 'model.Q4_K_M.gguf',
      sha256: LOCAL_SHA256,
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: remoteSize,
        checkedAt: 1,
        sha256: LOCAL_SHA256,
      },
      metadataTrust: 'verified_local',
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          {
            ...makeRepo(localModel.id, remoteSize),
            config: {
              max_position_embeddings: 8192,
            },
          },
        ]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('verified-local-context-model');

    expect(result.models[0]).toEqual(expect.objectContaining({
      id: localModel.id,
      localPath: localModel.localPath,
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
    }));
  });

  it('returns local models with a warning when the first page is rate limited', async () => {
    const localModel = makeLocalModel('local/offline-model');
    mockedRegistry.getModels.mockReturnValue([localModel]);
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('offline');

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject(localModel);
    expect(result.hasMore).toBe(false);
    expect(result.warning).toBeInstanceOf(ModelCatalogError);
    expect(result.warning?.code).toBe('rate_limited');
  });

  it('reuses the persisted first-page catalog cache for offline cold starts', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/persisted-catalog-model')]),
      }),
    ) as jest.Mock;

    const initialResult = await modelCatalogService.searchModels('phi', { pageSize: 10 });
    expect(initialResult.models[0].id).toBe('org/persisted-catalog-model');

    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: false });
    const coldStartService = new ModelCatalogService();

    const offlineResult = await coldStartService.searchModels('phi', { pageSize: 10 });
    coldStartService.dispose();

    expect(offlineResult.models[0].id).toBe('org/persisted-catalog-model');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('sanitizes untrusted persisted search cursors before returning cached results', async () => {
    (modelCatalogService as any).persistentCache.putSearch(
      (modelCatalogService as any).buildPersistentSearchScope('phi gguf', 10, null, false),
      {
        models: [{
          id: 'org/persisted-cursor-model',
          name: 'persisted-cursor-model',
          author: 'org',
          size: 1024,
          downloadUrl: 'https://huggingface.co/org/persisted-cursor-model/resolve/main/model.gguf',
          fitsInRam: true,
          accessState: ModelAccessState.PUBLIC,
          isGated: false,
          isPrivate: false,
          lifecycleStatus: LifecycleStatus.AVAILABLE,
          downloadProgress: 0,
        }],
        hasMore: true,
        nextCursor: 'https://example.com/api/models?cursor=steal-token',
      },
    );

    const cachedResult = modelCatalogService.getCachedSearchResult('phi', { pageSize: 10 });

    expect(cachedResult?.models[0].id).toBe('org/persisted-cursor-model');
    expect(cachedResult?.hasMore).toBe(false);
    expect(cachedResult?.nextCursor).toBeNull();
  });

  it('keeps authenticated first-page search results out of persisted cold-start cache during token hydration', async () => {
    await huggingFaceTokenService.clearToken();
    await SecureStore.setItemAsync('huggingface-access-token', 'hf_bootstrap_token');

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/auth-persisted-model')]),
      }),
    ) as jest.Mock;

    const initialResult = await modelCatalogService.searchModels('phi', { pageSize: 10 });
    expect(initialResult.models[0].id).toBe('org/auth-persisted-model');

    const coldStartService = new ModelCatalogService();
    await huggingFaceTokenService.refreshState();
    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: false });
    global.fetch = jest.fn() as jest.Mock;

    const offlineResult = await coldStartService.searchModels('phi', { pageSize: 10 });
    coldStartService.dispose();

    expect(offlineResult.models).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not persist an empty auth-derived search over a stale anonymous first-page cache', async () => {
    const staleAnonModel = makeLocalModel('org/stale-public-cache-model');
    (modelCatalogService as any).persistentCache.putSearch(
      (modelCatalogService as any).buildPersistentSearchScope('phi', 10, null, false),
      {
        models: [staleAnonModel],
        hasMore: false,
        nextCursor: null,
      },
    );
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{
          ...makeRepo('org/token-gated-search-model'),
          gated: 'manual',
        }]),
        headers: { get: jest.fn(() => null) },
      });
    }) as jest.Mock;

    const initialResult = await modelCatalogService.searchModels('phi', { pageSize: 10 });
    expect(initialResult.models[0]).toEqual(expect.objectContaining({
      id: 'org/token-gated-search-model',
      accessState: ModelAccessState.AUTHORIZED,
      isGated: true,
    }));

    await huggingFaceTokenService.clearToken();
    const coldStartService = new ModelCatalogService();
    const cachedResult = coldStartService.getCachedSearchResult('phi', { pageSize: 10 });
    coldStartService.dispose();

    expect(cachedResult).toBeNull();
  });

  it('does not use auth-derived persisted search fallback before token hydration finishes', async () => {
    await huggingFaceTokenService.clearToken();
    await SecureStore.setItemAsync('huggingface-access-token', 'hf_bootstrap_token');

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/auth-fallback-model')]),
      }),
    ) as jest.Mock;

    await modelCatalogService.searchModels('phi', { pageSize: 10 });

    const coldStartService = new ModelCatalogService();
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
      }),
    ) as jest.Mock;

    const fallbackResult = await coldStartService.searchModels('phi', { pageSize: 10 });
    coldStartService.dispose();

    expect(fallbackResult.models).toEqual([]);
    expect(fallbackResult.warning?.code).toBe('rate_limited');
  });

  it('retries the first-page search when the auth token changes mid-flight and keeps only the fresh cache entry', async () => {
    await huggingFaceTokenService.saveToken('hf_token_a');
    const firstPage = createDeferred<any>();
    const service = new ModelCatalogService();
    let firstRequestSignal: AbortSignal | undefined;

    global.fetch = (
      jest.fn()
        .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
          firstRequestSignal = init?.signal ?? undefined;
          return new Promise((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
            void firstPage.promise.then(resolve, reject);
          });
        })
        .mockImplementationOnce(() => Promise.resolve({
          ok: true,
          json: () => Promise.resolve([makeRepo('org/auth-new-model')]),
          headers: {
            get: jest.fn(() => null),
          },
        }))
    ) as jest.Mock;

    const pendingResult = service.searchModels('phi', { pageSize: 10 });
    await waitForMockCallCount(global.fetch as jest.Mock, 1);
    await huggingFaceTokenService.saveToken('hf_token_b');
    firstPage.resolve({
      ok: true,
      json: () => Promise.resolve([makeRepo('org/auth-old-model')]),
      headers: {
        get: jest.fn(() => null),
      },
    });

    const result = await pendingResult;
    const coldStartService = new ModelCatalogService();
    const cachedResult = coldStartService.getCachedSearchResult('phi', { pageSize: 10 });

    expect(result.models[0].id).toBe('org/auth-new-model');
    expect(cachedResult).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(firstRequestSignal?.aborted).toBe(true);

    coldStartService.dispose();
    service.dispose();
  });

  it('invalidates auth caches when refreshState detects a replaced non-empty token', async () => {
    await huggingFaceTokenService.saveToken('hf_token_a');
    const service = new ModelCatalogService();
    let requestCount = 0;

    global.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }

      requestCount += 1;
      const authHeader = (init?.headers as { Authorization?: string } | undefined)?.Authorization;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          {
            ...makeRepo(`org/token-${authHeader === 'Bearer hf_token_b' ? 'b' : 'a'}-${requestCount}`),
            gated: 'manual',
          },
        ]),
      });
    }) as jest.Mock;

    try {
      const firstResult = await service.searchModels('phi', { pageSize: 10 });
      await SecureStore.setItemAsync('huggingface-access-token', 'hf_token_b');
      await huggingFaceTokenService.refreshState();
      expect(service.getCachedModel(firstResult.models[0].id)?.accessState).toBe(ModelAccessState.AUTH_REQUIRED);
      const secondResult = await service.searchModels('phi', { pageSize: 10 });

      expect(firstResult.models[0].id).toBe('org/token-a-1');
      expect(secondResult.models[0].id).toBe('org/token-b-2');
      expect((global.fetch as jest.Mock).mock.calls.filter((call) => call[1]?.method !== 'HEAD')).toHaveLength(2);
      expect((global.fetch as jest.Mock).mock.calls[1][1]).toMatchObject({
        method: 'HEAD',
      });
      expect((global.fetch as jest.Mock).mock.calls[2][1]).toMatchObject({
        headers: {
          Authorization: 'Bearer hf_token_b',
        },
      });
    } finally {
      service.dispose();
    }
  });

  it('throws load-more errors for later pages instead of silently falling back', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
      }),
    ) as jest.Mock;

    await expect(modelCatalogService.searchModels('phi', {
      cursor: 'https://huggingface.co/api/models?search=phi%20gguf&limit=20&cursor=page-2',
      pageSize: 10,
    })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('rejects untrusted load-more cursors before attaching auth headers', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    })) as jest.Mock;

    await expect(modelCatalogService.searchModels('phi', {
      cursor: 'https://example.com/api/models?cursor=steal-token',
      pageSize: 10,
    })).rejects.toMatchObject({
      code: 'network',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('disables cached pagination offline and rejects offline cursor fetches', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=20&cursor=page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([makeRepo('org/offline-cached-model')]),
      }),
    ) as jest.Mock;

    const initialResult = await modelCatalogService.searchModels('phi', { pageSize: 10 });

    expect(initialResult.models).toHaveLength(1);
    expect(initialResult.hasMore).toBe(false);
    expect(initialResult.nextCursor).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);

    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: false });

    const cachedFirstPage = modelCatalogService.getCachedSearchResult('phi', { pageSize: 10 });
    expect(cachedFirstPage?.hasMore).toBe(false);
    expect(cachedFirstPage?.nextCursor).toBeNull();

    const offlineResult = await modelCatalogService.searchModels('phi', { pageSize: 10 });
    expect(offlineResult.hasMore).toBe(false);
    expect(offlineResult.nextCursor).toBeNull();

    await expect(modelCatalogService.searchModels('phi', {
      cursor: 'https://huggingface.co/api/models?search=phi%20gguf&limit=20&cursor=page-2',
      pageSize: 10,
    })).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('sets hasMore false when the response has no next cursor header', async () => {
    const repos = Array.from({ length: 10 }, (_, index) =>
      index < 3
        ? makeRepo(`org/model-${index}`)
        : makeRepo(`org/not-gguf-${index}`, 1024, 'README.md'),
    );

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(repos),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi', { pageSize: 10 });

    expect(result.models).toHaveLength(3);
    expect(result.hasMore).toBe(false);
  });

  it('keeps GGUF entries even when the list response omits file size metadata', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === 'string' && input.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
              size: 2 * 1024 * 1024 * 1024,
              lfs: { sha256: TREE_SHA256 },
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/unknown-size-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/unknown-size-model');
    expect(result.models[0].size).toBe(2 * 1024 * 1024 * 1024);
    expect(result.models[0].sha256).toBe(TREE_SHA256);
    expect(result.models[0].requiresTreeProbe).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/tree/main?recursive=true');
  });

  it('preserves verified local metadata when tree probes omit the remote digest', async () => {
    const service = new ModelCatalogService();
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/tree-missing-digest-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      requiresTreeProbe: true,
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      expect(String(input)).toContain('/tree/main?recursive=true');
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          path: 'model.Q4_K_M.gguf',
          size: 4 * 1024 * 1024 * 1024,
        }]),
      });
    }) as jest.Mock;

    const [resolved] = await (service as any).resolveMissingModelMetadata(
      [localModel],
      { totalMemoryBytes: 8 * 1024 * 1024 * 1024, systemMemorySnapshot: null },
      { authToken: null, hasAuthToken: false, authVersion: 0 },
    );

    expect(resolved).toEqual(expect.objectContaining({
      id: localModel.id,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      requiresTreeProbe: false,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    }));
    expect(resolved.downloadIntegrity).toEqual(localModel.downloadIntegrity);
    expect(resolved.gguf).toEqual(expect.objectContaining({
      totalBytes: 4 * 1024 * 1024 * 1024,
      architecture: 'llama',
      nLayers: 40,
    }));

    service.dispose();
  });

  it('keeps public GGUF repos visible when the list response omits siblings entirely', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (typeof input === 'string' && input.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
              size: 2 * 1024 * 1024 * 1024,
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([makeIncompletePublicRepo('org/public-probe-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/public-probe-model');
    expect(result.models[0].accessState).toBe(ModelAccessState.PUBLIC);
    expect(result.models[0].size).toBe(2 * 1024 * 1024 * 1024);
    expect(result.models[0].requiresTreeProbe).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/tree/main?recursive=true');
  });

  it('uses bounded tree probing for search results and defers full variant inventory to details', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tree/main?recursive=true&cursor=tree-page-2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            { path: 'model.Q8_0.gguf', size: 8 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models/org/bounded-tree-model/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
                : null
            )),
          },
          json: () => Promise.resolve([
            { path: 'model.Q4_K_M.gguf', size: 3 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([makeIncompletePublicRepo('org/bounded-tree-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.models[0]).toEqual(expect.objectContaining({
      id: 'org/bounded-tree-model',
      resolvedFileName: 'model.Q4_K_M.gguf',
      requiresTreeProbe: true,
    }));
    expect(result.models[0].variants?.map((variant) => variant.fileName)).toEqual(['model.Q4_K_M.gguf']);
  });

  it('keeps nullable size when both list and tree metadata omit the file size', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (typeof input === 'string' && input.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/still-unknown-size-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].size).toBeNull();
    expect(result.models[0].fitsInRam).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('prefers the Q4_K_M quant even when Hugging Face only exposes filename metadata', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeFilenameOnlyRepo('org/filename-only-model')]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].resolvedFileName).toBe('model.Q4_K_M.gguf');
    expect(result.models[0].size).toBe(3 * 1024 * 1024 * 1024);
    expect(result.models[0].metadataTrust).toBe('trusted_remote');
    expect(result.models[0].gguf).toEqual(expect.objectContaining({
      totalBytes: 3 * 1024 * 1024 * 1024,
    }));
    expect(result.models[0].downloadUrl).toContain('model.Q4_K_M.gguf');
  });

  it('infers metadata trust when model size comes from summary gguf totals', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          {
            id: 'org/inferred-size-model',
            gguf: {
              total: 2 * 1024 * 1024 * 1024,
              architecture: 'llama',
              context_length: 2048,
              size_label: '2B',
            },
            siblings: [
              { rfilename: 'model.Q4_K_M.gguf' },
            ],
          },
        ]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].size).toBe(2 * 1024 * 1024 * 1024);
    expect(result.models[0].metadataTrust).toBe('inferred');
    expect(result.models[0].gguf).toEqual(expect.objectContaining({
      totalBytes: 2 * 1024 * 1024 * 1024,
      architecture: 'llama',
      contextLengthTokens: 2048,
      sizeLabel: '2B',
    }));
  });

  it('promotes tree-resolved file size to trusted metadata and refreshes stale GGUF totals', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (typeof input === 'string' && input.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
              size: 3 * 1024 * 1024 * 1024,
              lfs: { oid: TREE_SHA256 },
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          id: 'org/tree-trusted-size-model',
          tags: ['gguf', 'chat'],
          gguf: {
            total: 2 * 1024 * 1024 * 1024,
            architecture: 'llama',
            context_length: 2048,
          },
        }]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');
    const model = result.models[0];

    expect(model.size).toBe(3 * 1024 * 1024 * 1024);
    expect(model.metadataTrust).toBe('trusted_remote');
    expect(model.sha256).toBe(TREE_SHA256);
    expect(model.gguf).toEqual(expect.objectContaining({
      totalBytes: 3 * 1024 * 1024 * 1024,
      architecture: 'llama',
      contextLengthTokens: 2048,
    }));
  });

  it('clears stale inferred GGUF totals when tree metadata confirms only an unknown-size file', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (typeof input === 'string' && input.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            { path: 'model.Q4_K_M.gguf' },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          id: 'org/tree-unknown-size-model',
          tags: ['gguf', 'chat'],
          gguf: {
            total: 2 * 1024 * 1024 * 1024,
            architecture: 'llama',
          },
        }]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');
    const model = result.models[0];

    expect(model.size).toBeNull();
    expect(model.metadataTrust).toBeUndefined();
    expect(model.gguf).toEqual(expect.objectContaining({ architecture: 'llama' }));
    expect(model.gguf).not.toEqual(expect.objectContaining({ totalBytes: expect.any(Number) }));
    expect(model.memoryFitDecision).toBeUndefined();
    expect(model.memoryFitConfidence).toBeUndefined();
  });

  it('resets unverified local downloads when remote size conflicts with persisted state', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/unverified-local-size-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 1 * 1024 * 1024 * 1024,
      metadataTrust: 'unknown',
      localPath: 'unverified-local-size-model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 3 * 1024 * 1024 * 1024,
            lfs: { sha256: LOCAL_SHA256 },
          }],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe(localModel.id);
    expect(result.models[0].localPath).toBeUndefined();
    expect(result.models[0].lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(result.models[0].downloadProgress).toBe(0);
    expect(result.models[0].size).toBe(3 * 1024 * 1024 * 1024);
  });

  it('prefers verified local sizes over remote sizes when merging catalog results with the registry', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/verified-local-size-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      localPath: 'verified-local-size-model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 3 * 1024 * 1024 * 1024,
            lfs: { sha256: LOCAL_SHA256 },
          }],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe(localModel.id);
    expect(result.models[0].localPath).toBe(localModel.localPath);
    expect(result.models[0].lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    expect(result.models[0].size).toBe(4 * 1024 * 1024 * 1024);
    expect(result.models[0].metadataTrust).toBe('verified_local');
    expect(result.models[0].gguf).toEqual(expect.objectContaining({ totalBytes: 4 * 1024 * 1024 * 1024 }));
  });

  it('preserves local download integrity markers when merging catalog results with the registry', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/verified-local-integrity-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      localPath: 'verified-local-integrity-model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 3 * 1024 * 1024 * 1024,
            lfs: { sha256: LOCAL_SHA256 },
          }],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0].downloadIntegrity).toEqual(localModel.downloadIntegrity);
  });

  it('preserves downloaded non-default variant state when merging catalog defaults with the registry', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/downloaded-q8-variant-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 8 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 8 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      localPath: 'downloaded-q8-variant-model.Q8_0.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 3 * 1024 * 1024 * 1024,
            lfs: { sha256: OTHER_TREE_SHA256 },
          }],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0]).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      localPath: localModel.localPath,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      size: 8 * 1024 * 1024 * 1024,
      metadataTrust: 'verified_local',
      sha256: LOCAL_SHA256,
    }));
    expect(result.models[0].variants?.some((variant) => variant.fileName === 'model.Q8_0.gguf')).toBe(true);
  });

  it('preserves legacy resolved-file-only downloaded variants when the exact variant is in the catalog', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/legacy-downloaded-q8-variant-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 8 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q8_0.gguf',
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 8 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      localPath: 'legacy-downloaded-q8-variant-model.Q8_0.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [
            {
              rfilename: 'model.Q4_K_M.gguf',
              size: 3 * 1024 * 1024 * 1024,
              lfs: { sha256: OTHER_TREE_SHA256 },
            },
            {
              rfilename: 'model.Q8_0.gguf',
              size: 8 * 1024 * 1024 * 1024,
              lfs: { sha256: LOCAL_SHA256 },
            },
          ],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0]).toEqual(expect.objectContaining({
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      localPath: localModel.localPath,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      size: 8 * 1024 * 1024 * 1024,
      metadataTrust: 'verified_local',
      sha256: LOCAL_SHA256,
    }));
  });

  it('preserves verified local integrity when catalog results omit the remote digest', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/verified-local-missing-remote-digest-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      localPath: 'verified-local-missing-remote-digest-model.gguf',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 4 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 4 * 1024 * 1024 * 1024,
          }],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0]).toEqual(expect.objectContaining({
      id: localModel.id,
      localPath: localModel.localPath,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    }));
    expect(result.models[0].downloadIntegrity).toEqual(localModel.downloadIntegrity);
    expect(result.models[0].gguf).toEqual(expect.objectContaining({
      totalBytes: 4 * 1024 * 1024 * 1024,
      architecture: 'llama',
      nLayers: 40,
    }));
  });

  it('resets local state when a missing-digest catalog result selects a different file', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/verified-local-missing-digest-new-file-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q4_K_M.gguf',
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      localPath: 'verified-local-missing-digest-new-file-model.gguf',
      downloadedAt: 123456,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 4 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q5_K_M.gguf',
            size: 4 * 1024 * 1024 * 1024,
          }],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0]).toEqual(expect.objectContaining({
      id: localModel.id,
      resolvedFileName: 'model.Q5_K_M.gguf',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      size: 4 * 1024 * 1024 * 1024,
      sha256: undefined,
      metadataTrust: 'trusted_remote',
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
    }));
    expect(result.models[0].downloadIntegrity).toBeUndefined();
    expect(result.models[0].gguf).toEqual({
      totalBytes: 4 * 1024 * 1024 * 1024,
    });
  });

  it('resets legacy downloaded local state when a missing-digest catalog result selects a different file', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/legacy-downloaded-new-file-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q4_K_M.gguf',
      sha256: undefined,
      metadataTrust: 'trusted_remote',
      downloadIntegrity: undefined,
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      localPath: 'legacy-downloaded-new-file-model.gguf',
      downloadedAt: 123456,
      resumeData: JSON.stringify({ resumeData: 'stale' }),
      downloadErrorAt: 234567,
      downloadErrorCode: 'download_http_error',
      downloadErrorMessage: 'stale failure',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 4 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q5_K_M.gguf',
            size: 4 * 1024 * 1024 * 1024,
          }],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0]).toEqual(expect.objectContaining({
      id: localModel.id,
      resolvedFileName: 'model.Q5_K_M.gguf',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      size: 4 * 1024 * 1024 * 1024,
      sha256: undefined,
      metadataTrust: 'trusted_remote',
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
    }));
    expect(result.models[0].downloadIntegrity).toBeUndefined();
    expect(result.models[0].gguf).toEqual({
      totalBytes: 4 * 1024 * 1024 * 1024,
    });
  });

  it('drops stale verified_local trust when the remote digest changes', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/stale-verified-local-integrity-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      localPath: 'stale-verified-local-integrity-model.gguf',
      downloadedAt: 123456,
      resumeData: JSON.stringify({ resumeData: 'stale' }),
      downloadErrorAt: 234567,
      downloadErrorCode: 'download_http_error',
      downloadErrorMessage: 'stale failure',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 3 * 1024 * 1024 * 1024,
            lfs: { sha256: OTHER_TREE_SHA256 },
          }],
        }]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0]).toEqual(expect.objectContaining({
      id: localModel.id,
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      size: 3 * 1024 * 1024 * 1024,
      sha256: OTHER_TREE_SHA256,
      metadataTrust: 'trusted_remote',
    }));
    expect(result.models[0].downloadIntegrity).toBeUndefined();
    expect(result.models[0].gguf?.totalBytes).toBe(3 * 1024 * 1024 * 1024);
    expect(result.models[0].gguf?.architecture).toBeUndefined();
    expect(result.models[0].gguf?.nLayers).toBeUndefined();
    expect(result.models[0].hasVerifiedContextWindow).toBe(false);
    expect(result.models[0].maxContextTokens).toBeUndefined();
  });

  it('does not restore verified local size when a conflicting digest has unknown remote size', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/stale-verified-local-unknown-size-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
      localPath: 'stale-verified-local-unknown-size-model.gguf',
      downloadedAt: 123456,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([{
            path: 'model.Q4_K_M.gguf',
            lfs: { sha256: OTHER_TREE_SHA256 },
          }]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([{
          ...makeRepoWithUnknownSize(localModel.id),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            lfs: { sha256: OTHER_TREE_SHA256 },
          }],
        }]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0]).toEqual(expect.objectContaining({
      id: localModel.id,
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      size: null,
      sha256: OTHER_TREE_SHA256,
      fitsInRam: null,
    }));
    expect(result.models[0].metadataTrust).toBeUndefined();
    expect(result.models[0].downloadIntegrity).toBeUndefined();
    expect(result.models[0].gguf).toBeUndefined();
    expect(result.models[0].memoryFitDecision).toBeUndefined();
    expect(result.models[0].memoryFitConfidence).toBeUndefined();
    expect(result.models[0].hasVerifiedContextWindow).toBe(false);
    expect(result.models[0].maxContextTokens).toBeUndefined();
  });

  it('skips mmproj projector files when selecting a GGUF download candidate', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          {
            id: 'org/mixed-mmproj-model',
            siblings: [
              { rfilename: 'model.mmproj.gguf', size: 512 * 1024 * 1024 },
              { rfilename: 'model.Q8_0.gguf', size: 5 * 1024 * 1024 * 1024 },
            ],
          },
        ]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].resolvedFileName).toBe('model.Q8_0.gguf');
    expect(result.models[0].metadataTrust).toBe('trusted_remote');
    expect(result.models[0].gguf).toEqual(expect.objectContaining({
      totalBytes: 5 * 1024 * 1024 * 1024,
    }));
    expect(result.models[0].downloadUrl).toContain('model.Q8_0.gguf');
  });

  it('does not reject text GGUFs that merely contain projector in the repo naming', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          {
            id: 'org/projector-series-text-model',
            siblings: [
              { rfilename: 'projector-series.Q8_0.gguf', size: 5 * 1024 * 1024 * 1024 },
            ],
          },
        ]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].resolvedFileName).toBe('projector-series.Q8_0.gguf');
    expect(result.models[0].downloadUrl).toContain('projector-series.Q8_0.gguf');
  });

  it('does not force a tree revalidation when the summary exposes a single known quant file', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          makeRepo('org/single-known-quant-model', 5 * 1024 * 1024 * 1024, 'model.Q8_0.gguf'),
        ]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].resolvedFileName).toBe('model.Q8_0.gguf');
    expect(result.models[0].size).toBe(5 * 1024 * 1024 * 1024);
    expect(result.models[0].metadataTrust).toBe('trusted_remote');
    expect(result.models[0].gguf).toEqual(expect.objectContaining({
      totalBytes: 5 * 1024 * 1024 * 1024,
    }));
    expect(result.models[0].requiresTreeProbe).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps discovered GGUF metadata while leaving tree-probe models unresolved when pagination stops early', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-2')) {
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve([]),
        });
      }

      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models/org/incomplete-tree-probe/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
                : null
            )),
          },
          json: () => Promise.resolve([
            {
              path: 'model.Q8_0.gguf',
              size: 5 * 1024 * 1024 * 1024,
              lfs: { sha256: OTHER_TREE_SHA256 },
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([makeIncompletePublicRepo('org/incomplete-tree-probe')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/incomplete-tree-probe');
    expect(result.models[0].requiresTreeProbe).toBe(true);
    expect(result.models[0].resolvedFileName).toBe('model.Q8_0.gguf');
    expect(result.models[0].downloadUrl).toBe('https://huggingface.co/org/incomplete-tree-probe/resolve/main/model.Q8_0.gguf');
    expect(result.models[0].size).toBe(5 * 1024 * 1024 * 1024);
    expect(result.models[0].sha256).toBe(OTHER_TREE_SHA256);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('cursor=tree-page-2');
  });

  it('preserves an existing tree-probe artifact when the exact file is beyond the bounded page budget', async () => {
    const service = new ModelCatalogService();
    const model: ModelMetadata = {
      id: 'org/bounded-preserve-existing-artifact',
      name: 'bounded-preserve-existing-artifact',
      author: 'org',
      size: 8 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/bounded-preserve-existing-artifact/resolve/main/model.Q8_0.gguf',
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      sha256: LOCAL_SHA256,
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      metadataTrust: 'trusted_remote',
      gguf: {
        totalBytes: 8 * 1024 * 1024 * 1024,
        architecture: 'llama',
      },
      variants: [{
        variantId: 'model.Q8_0.gguf',
        fileName: 'model.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8 * 1024 * 1024 * 1024,
        sha256: LOCAL_SHA256,
        ramFit: 'likely_oom',
        ramFitConfidence: 'high',
      }],
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: true,
    };
    const makeTreePage = (
      nextCursor: string | null,
      entries: Array<Record<string, unknown>>,
    ) => Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn((headerName: string) => (
          headerName === 'link' && nextCursor
            ? `<https://huggingface.co/api/models/${model.id}/tree/main?recursive=true&cursor=${nextCursor}>; rel="next"`
            : null
        )),
      },
      json: () => Promise.resolve(entries),
    });

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-5')) {
        return makeTreePage(null, [
          {
            path: 'model.Q8_0.gguf',
            size: 8 * 1024 * 1024 * 1024,
            lfs: { sha256: LOCAL_SHA256 },
          },
        ]);
      }

      if (url.includes('cursor=tree-page-4')) {
        return makeTreePage('tree-page-5', [{ path: 'README-page-4.md', size: 1024 }]);
      }

      if (url.includes('cursor=tree-page-3')) {
        return makeTreePage('tree-page-4', [{ path: 'README-page-3.md', size: 1024 }]);
      }

      if (url.includes('cursor=tree-page-2')) {
        return makeTreePage('tree-page-3', [{ path: 'README-page-2.md', size: 1024 }]);
      }

      return makeTreePage('tree-page-2', [
        {
          path: 'model.Q4_K_M.gguf',
          size: 3 * 1024 * 1024 * 1024,
          lfs: { sha256: OTHER_TREE_SHA256 },
        },
      ]);
    }) as jest.Mock;

    const [resolved] = await (service as any).resolveMissingModelMetadata(
      [model],
      { totalMemoryBytes: 8 * 1024 * 1024 * 1024, systemMemorySnapshot: null },
      { authToken: null, hasAuthToken: false, authVersion: 0 },
      { treeProbeMode: 'bounded' },
    );

    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([input]) => String(input).includes('cursor=tree-page-5')),
    ).toBe(false);
    expect(resolved).toEqual(expect.objectContaining({
      id: model.id,
      resolvedFileName: model.resolvedFileName,
      activeVariantId: model.activeVariantId,
      downloadUrl: model.downloadUrl,
      sha256: model.sha256,
      size: model.size,
      metadataTrust: model.metadataTrust,
      fitsInRam: model.fitsInRam,
      memoryFitDecision: model.memoryFitDecision,
      memoryFitConfidence: model.memoryFitConfidence,
      requiresTreeProbe: true,
    }));
    expect(resolved.gguf).toEqual(model.gguf);
    expect(resolved.variants).toEqual(model.variants);

    service.dispose();
  });

  it('preserves an existing auth-validated artifact when bounded tree fallback misses the exact file', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    const authSnapshot = await huggingFaceTokenService.getSnapshot();
    const service = new ModelCatalogService();
    const model: ModelMetadata = {
      id: 'org/bounded-auth-preserve-model',
      name: 'bounded-auth-preserve-model',
      author: 'org',
      size: 8 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/bounded-auth-preserve-model/resolve/main/model.Q8_0.gguf',
      resolvedFileName: 'model.Q8_0.gguf',
      activeVariantId: 'model.Q8_0.gguf',
      sha256: LOCAL_SHA256,
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
      memoryFitConfidence: 'high',
      metadataTrust: 'trusted_remote',
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: false,
    };
    const makeTreePage = (
      nextCursor: string | null,
      entries: Array<Record<string, unknown>>,
    ) => Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn((headerName: string) => (
          headerName === 'link' && nextCursor
            ? `<https://huggingface.co/api/models/${model.id}/tree/main?recursive=true&cursor=${nextCursor}>; rel="next"`
            : null
        )),
      },
      json: () => Promise.resolve(entries),
    });

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return Promise.reject(new Error('transient auth probe failure'));
      }

      const url = String(input);
      if (url.includes('cursor=tree-page-4')) {
        return makeTreePage('tree-page-5', [{ path: 'README-page-4.md', size: 1024 }]);
      }

      if (url.includes('cursor=tree-page-3')) {
        return makeTreePage('tree-page-4', [{ path: 'README-page-3.md', size: 1024 }]);
      }

      if (url.includes('cursor=tree-page-2')) {
        return makeTreePage('tree-page-3', [{ path: 'README-page-2.md', size: 1024 }]);
      }

      return makeTreePage('tree-page-2', [
        {
          path: 'model.Q4_K_M.gguf',
          size: 3 * 1024 * 1024 * 1024,
          lfs: { sha256: OTHER_TREE_SHA256 },
        },
      ]);
    }) as jest.Mock;

    const [resolved] = await (service as any).resolveMissingModelMetadata(
      [model],
      { totalMemoryBytes: 8 * 1024 * 1024 * 1024, systemMemorySnapshot: null },
      {
        authToken: authSnapshot.token,
        hasAuthToken: true,
        authVersion: authSnapshot.revision,
      },
      { treeProbeMode: 'bounded' },
    );

    expect(global.fetch).toHaveBeenCalledTimes(5);
    expect(resolved).toEqual(expect.objectContaining({
      resolvedFileName: model.resolvedFileName,
      activeVariantId: model.activeVariantId,
      downloadUrl: model.downloadUrl,
      sha256: model.sha256,
      size: model.size,
      metadataTrust: model.metadataTrust,
      requiresTreeProbe: true,
    }));

    service.dispose();
  });

  it('follows paginated tree cursors until it finds the GGUF entry metadata', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
              size: 3 * 1024 * 1024 * 1024,
              lfs: { sha256: PAGED_TREE_SHA256 },
            },
          ]),
        });
      }

      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models/org/paged-tree-model/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
                : null
            )),
          },
          json: () => Promise.resolve([
            { path: 'README.md', size: 1024 },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/paged-tree-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].size).toBe(3 * 1024 * 1024 * 1024);
    expect(result.models[0].sha256).toBe(PAGED_TREE_SHA256);
    expect(result.models[0].requiresTreeProbe).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('cursor=tree-page-2');
  });

  it('falls back to preferred pagination stop when the expected tree filename is a projector', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-3')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            { path: 'unnecessary.Q8_0.gguf', size: 4 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      if (url.includes('cursor=tree-page-2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models/org/paged-projector-model/tree/main?recursive=true&cursor=tree-page-3>; rel="next"'
                : null
            )),
          },
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
              size: 3 * 1024 * 1024 * 1024,
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models/org/paged-projector-model/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([
          { path: 'model.mmproj.gguf', size: 512 * 1024 * 1024 },
        ]),
      });
    }) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const treeResponse = await (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/paged-projector-model',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
      { expectedFileName: 'model.mmproj.gguf' },
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(treeResponse.entries.map((entry: { path?: string }) => entry.path)).toEqual([
      'model.mmproj.gguf',
      'model.Q4_K_M.gguf',
    ]);
    expect(treeResponse.isComplete).toBe(false);
    expect(treeResponse.stopReason).toBe('preferred_found');
  });

  it('stops at the expected embedded MTP tree filename', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-3')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            { path: 'unnecessary.Q8_0.gguf', size: 4 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      if (url.includes('cursor=tree-page-2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models/org/paged-mtp-model/tree/main?recursive=true&cursor=tree-page-3>; rel="next"'
                : null
            )),
          },
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
              size: 3 * 1024 * 1024 * 1024,
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models/org/paged-mtp-model/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([
          { path: 'model.NextN.Q4_K_M.gguf', size: 512 * 1024 * 1024 },
        ]),
      });
    }) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const treeResponse = await (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/paged-mtp-model',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
      { expectedFileName: 'model.NextN.Q4_K_M.gguf' },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(treeResponse.entries.map((entry: { path?: string }) => entry.path)).toEqual([
      'model.NextN.Q4_K_M.gguf',
    ]);
    expect(treeResponse.isComplete).toBe(false);
    expect(treeResponse.stopReason).toBe('target_found');
  });

  it('looks past lower-ranked GGUF files before using the preferred tree pagination stop', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-3')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            { path: 'unnecessary.Q8_0.gguf', size: 4 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      if (url.includes('cursor=tree-page-2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models/org/paged-quant-model/tree/main?recursive=true&cursor=tree-page-3>; rel="next"'
                : null
            )),
          },
          json: () => Promise.resolve([
            { path: 'model.Q4_K_M.gguf', size: 3 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models/org/paged-quant-model/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([
          { path: 'model.Q4_0.gguf', size: 2.5 * 1024 * 1024 * 1024 },
        ]),
      });
    }) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const treeResponse = await (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/paged-quant-model',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(treeResponse.entries.map((entry: { path?: string }) => entry.path)).toEqual([
      'model.Q4_0.gguf',
      'model.Q4_K_M.gguf',
    ]);
    expect(treeResponse.isComplete).toBe(false);
    expect(treeResponse.stopReason).toBe('preferred_found');
  });

  it('keeps searching when an eligible expected tree filename appears after a preferred candidate', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            { path: 'exact.Q8_0.gguf', size: 4 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models/org/paged-exact-model/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([
          { path: 'earlier.Q4_K_M.gguf', size: 3 * 1024 * 1024 * 1024 },
        ]),
      });
    }) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const treeResponse = await (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/paged-exact-model',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
      { expectedFileName: 'exact.Q8_0.gguf' },
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(treeResponse.entries.map((entry: { path?: string }) => entry.path)).toEqual([
      'earlier.Q4_K_M.gguf',
      'exact.Q8_0.gguf',
    ]);
    expect(treeResponse.isComplete).toBe(true);
    expect(treeResponse.stopReason).toBe('target_found');
  });

  it('keeps full-tree probes paginating past preferred fallback matches', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            { path: 'later.Q8_0.gguf', size: 4 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models/org/full-tree-preferred/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([
          { path: 'early.Q4_K_M.gguf', size: 3 * 1024 * 1024 * 1024 },
        ]),
      });
    }) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const treeResponse = await (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/full-tree-preferred',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
      { allowTargetEarlyStop: false },
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(treeResponse.entries.map((entry: { path?: string }) => entry.path)).toEqual([
      'early.Q4_K_M.gguf',
      'later.Q8_0.gguf',
    ]);
    expect(treeResponse.isComplete).toBe(true);
    expect(treeResponse.stopReason).toBe('complete');
  });

  it('keeps full-tree probes paginating past lookahead fallback limits', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const makePage = (cursor: string | null, entries: Array<{ path: string; size?: number }>) => Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link' && cursor
              ? `<https://huggingface.co/api/models/org/full-tree-lookahead/tree/main?recursive=true&cursor=${cursor}>; rel="next"`
              : null
          )),
        },
        json: () => Promise.resolve(entries),
      });

      if (url.includes('cursor=tree-page-4')) {
        return makePage(null, [
          { path: 'final.Q8_0.gguf', size: 4 * 1024 * 1024 * 1024 },
        ]);
      }

      if (url.includes('cursor=tree-page-3')) {
        return makePage('tree-page-4', [
          { path: 'README.md' },
        ]);
      }

      if (url.includes('cursor=tree-page-2')) {
        return makePage('tree-page-3', [
          { path: 'config.json' },
        ]);
      }

      return makePage('tree-page-2', [
        { path: 'early.Q3_K_S.gguf', size: 2 * 1024 * 1024 * 1024 },
      ]);
    }) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const treeResponse = await (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/full-tree-lookahead',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
      { allowTargetEarlyStop: false },
    );

    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(treeResponse.entries.map((entry: { path?: string }) => entry.path)).toEqual([
      'early.Q3_K_S.gguf',
      'config.json',
      'README.md',
      'final.Q8_0.gguf',
    ]);
    expect(treeResponse.isComplete).toBe(true);
    expect(treeResponse.stopReason).toBe('complete');
  });

  it('caps model details tree probes at the foreground detail page budget', async () => {
    const modelId = 'org/detail-tree-budget-model';
    const cachedModel: ModelMetadata = {
      ...makeLocalModel(modelId),
      size: null,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/target.Q8_0.gguf`,
      localPath: undefined,
      resolvedFileName: 'target.Q8_0.gguf',
      accessState: ModelAccessState.PUBLIC,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: true,
    };
    const cachedModelSpy = jest.spyOn(modelCatalogService, 'getCachedModel').mockImplementation((requestedModelId) => (
      requestedModelId === modelId ? cachedModel : null
    ));
    const makePage = (cursor: string | null, entries: Array<{ path: string; size?: number }>) => Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn((headerName: string) => (
          headerName === 'link' && cursor
            ? `<https://huggingface.co/api/models/${modelId}/tree/main?recursive=true&cursor=${cursor}>; rel="next"`
            : null
        )),
      },
      json: () => Promise.resolve(entries),
    });

    try {
      global.fetch = jest.fn((input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes(`/api/models/${modelId}/tree/main?recursive=true&cursor=tree-page-4`)) {
          return makePage('tree-page-5', [{ path: 'README-page-4.md', size: 1024 }]);
        }

        if (url.includes(`/api/models/${modelId}/tree/main?recursive=true&cursor=tree-page-3`)) {
          return makePage('tree-page-4', [{ path: 'README-page-3.md', size: 1024 }]);
        }

        if (url.includes(`/api/models/${modelId}/tree/main?recursive=true&cursor=tree-page-2`)) {
          return makePage('tree-page-3', [{ path: 'README-page-2.md', size: 1024 }]);
        }

        if (url.includes(`/api/models/${modelId}/tree/main?recursive=true`)) {
          return makePage('tree-page-2', [{ path: 'README-page-1.md', size: 1024 }]);
        }

        if (url.endsWith('/raw/main/README.md')) {
          return Promise.resolve({
            ok: false,
            status: 404,
            text: () => Promise.resolve(''),
          });
        }

        if (url.includes(`/api/models/${modelId}`)) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              id: modelId,
              tags: ['gguf'],
              siblings: [],
            }),
          });
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        });
      }) as jest.Mock;

      const result = await modelCatalogService.getModelDetails(modelId);
      const treeCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]) => (
        String(url).includes(`/api/models/${modelId}/tree/main?recursive=true`)
      ));

      expect(treeCalls).toHaveLength(4);
      expect(treeCalls.some(([url]) => String(url).includes('cursor=tree-page-5'))).toBe(false);
      expect(result.requiresTreeProbe).toBe(true);
    } finally {
      cachedModelSpy.mockRestore();
    }
  });

  it('caps bounded tree probes at the requested page budget', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const nextCursor = url.includes('cursor=tree-page-2') ? 'tree-page-3' : 'tree-page-2';

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? `<https://huggingface.co/api/models/org/bounded-page-budget/tree/main?recursive=true&cursor=${nextCursor}>; rel="next"`
              : null
          )),
        },
        json: () => Promise.resolve([
          { path: 'README.md' },
        ]),
      });
    }) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const treeResponse = await (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/bounded-page-budget',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
      { maxPages: 2 },
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(treeResponse.isComplete).toBe(false);
    expect(treeResponse.stopReason).toBe('max_pages');
  });

  it('stops tree pagination on untrusted next links without sending auth to them', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn((headerName: string) => (
          headerName === 'link'
            ? '<https://example.com/api/models/org/tree-token-leak/tree/main?cursor=steal-token>; rel="next"'
            : null
        )),
      },
      json: () => Promise.resolve([
        { path: 'model.Q4_K_M.gguf', size: 2 * 1024 * 1024 * 1024 },
      ]),
    })) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const treeResponse = await (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/tree-token-leak',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.OPTIONAL_AUTH,
      { allowTargetEarlyStop: false },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('https://huggingface.co/api/models');
    expect(treeResponse.entries).toHaveLength(1);
    expect(treeResponse.isComplete).toBe(false);
    expect(treeResponse.stopReason).toBe('invalid_cursor');
  });

  it('does not dedupe concurrent tree probes for different expected filenames', async () => {
    const firstResponse = createDeferred<any>();
    const secondResponse = createDeferred<any>();
    const pendingResponses = [firstResponse, secondResponse];
    let responseIndex = 0;
    const makeTreeResponse = (path: string, size: number) => ({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn(() => null),
      },
      json: () => Promise.resolve([{ path, size }]),
    });

    global.fetch = jest.fn(() => {
      const response = pendingResponses[responseIndex];
      responseIndex += 1;
      return response?.promise ?? Promise.reject(new Error('unexpected tree request'));
    }) as jest.Mock;

    const requestContext = await (modelCatalogService as any).createRequestContext();
    const firstTreePromise = (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/concurrent-tree-model',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
      { expectedFileName: 'target.Q4_K_M.gguf' },
    );
    const secondTreePromise = (modelCatalogService as any).fetchHuggingFaceModelTree(
      'org/concurrent-tree-model',
      undefined,
      requestContext,
      REQUEST_AUTH_POLICY.ANONYMOUS,
      { expectedFileName: 'target.Q8_0.gguf' },
    );

    await waitForMockCallCount(global.fetch as jest.Mock, 2);

    firstResponse.resolve(makeTreeResponse('target.Q4_K_M.gguf', 3 * 1024 * 1024 * 1024));
    secondResponse.resolve(makeTreeResponse('target.Q8_0.gguf', 5 * 1024 * 1024 * 1024));

    const [firstTreeResponse, secondTreeResponse] = await Promise.all([
      firstTreePromise,
      secondTreePromise,
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(firstTreeResponse.entries.map((entry: { path?: string }) => entry.path)).toEqual([
      'target.Q4_K_M.gguf',
    ]);
    expect(secondTreeResponse.entries.map((entry: { path?: string }) => entry.path)).toEqual([
      'target.Q8_0.gguf',
    ]);
  });

  it('marks gated models as auth_required when no token is configured', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          {
            ...makeRepo('org/gated-model'),
            gated: 'manual',
          },
        ]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTH_REQUIRED);
    expect(result.models[0].isGated).toBe(true);
  });

  it('does not keep stale local gated/private flags once remote metadata marks the model public', async () => {
    const localModel = {
      ...makeLocalModel('org/public-now-model'),
      isGated: true,
      isPrivate: true,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo(localModel.id)]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.PUBLIC);
    expect(result.models[0].isGated).toBe(false);
    expect(result.models[0].isPrivate).toBe(false);
  });

  it('marks gated models as access_denied when the tree endpoint rejects the configured token', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve([]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          {
            ...makeRepoWithUnknownSize('org/denied-model'),
            gguf: { total: 2 * 1024 * 1024 * 1024 },
            gated: 'manual',
          },
        ]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.ACCESS_DENIED);
    expect(result.models[0].requiresTreeProbe).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('marks gated models as access_denied when the tree endpoint hides unauthorized access as 404', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve([]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          {
            ...makeRepoWithUnknownSize('org/hidden-denied-model'),
            gguf: { total: 2 * 1024 * 1024 * 1024 },
            gated: 'manual',
          },
        ]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.ACCESS_DENIED);
    expect(result.models[0].requiresTreeProbe).toBe(true);
  });

  it('revalidates size-known gated models with a lightweight file access probe before marking them authorized', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: false,
          status: 403,
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          {
            ...makeRepo('org/size-known-gated-model'),
            gated: 'manual',
          },
        ]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.ACCESS_DENIED);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/resolve/main/model.Q4_K_M.gguf');
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toMatchObject({ method: 'HEAD' });
  });

  it('treats hidden resolved-file 404 probes as access_denied for gated models', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: false,
          status: 404,
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          {
            ...makeRepo('org/hidden-file-gated-model'),
            gated: 'manual',
          },
        ]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.ACCESS_DENIED);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/resolve/main/model.Q4_K_M.gguf');
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toMatchObject({ method: 'HEAD' });
  });

  it('falls back to a ranged GET probe when the resolved-file HEAD request is unsupported', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/resolve/main/model.Q4_K_M.gguf')) {
        if (init?.method === 'HEAD') {
          return Promise.resolve({
            ok: false,
            status: 405,
          });
        }

        return Promise.resolve({
          ok: true,
          status: 206,
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          {
            ...makeRepo('org/head-unsupported-gated-model'),
            gated: 'manual',
          },
        ]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0].accessState).toBe(ModelAccessState.AUTHORIZED);

    const refreshed = await modelCatalogService.refreshModelMetadata(result.models[0], { includeDetails: false });

    expect(refreshed.accessState).toBe(ModelAccessState.AUTHORIZED);
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toMatchObject({ method: 'HEAD' });
    expect((global.fetch as jest.Mock).mock.calls[2][1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer hf_test_token',
        Range: 'bytes=0-0',
      }),
    });
  });

  it('derives hasMore from the next cursor header without extra page-proving fetches', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('limit=20')) {
        const repos = Array.from({ length: 10 }, (_, index) => makeRepo(`org/model-${index}`));

        return Promise.resolve({
          ok: true,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=20&cursor=page-2>; rel="next"'
                : null
            )),
          },
          json: () => Promise.resolve(repos),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi', { pageSize: 10 });

    expect(result.models).toHaveLength(10);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toContain('cursor=page-2');
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('sets hasMore false when the API returns fewer repos than requested', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/model-1'), makeRepo('org/model-2')]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi', { pageSize: 10 });

    expect(result.models).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it('uses the parsed next cursor URL for follow-up cursor batches', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=page-2')) {
        return Promise.resolve({
          ok: true,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=1&cursor=page-3>; rel="next", <https://huggingface.co/api/models?search=phi%20gguf&limit=1&cursor=page-1>; rel="prev"'
                : null
            )),
          },
          json: () => Promise.resolve([makeRepo('org/model-2')]),
        });
      }

      return Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=1&cursor=page-2>; rel="next", <https://huggingface.co/api/models?search=phi%20gguf&limit=1&cursor=page-0>; rel="prev"'
              : null
          )),
        },
        json: () => Promise.resolve([makeRepo('org/model-1')]),
      });
    }) as jest.Mock;

    const firstPage = await modelCatalogService.searchModels('phi', { pageSize: 1 });
    const secondPage = await modelCatalogService.searchModels('phi', {
      cursor: firstPage.nextCursor,
      pageSize: 1,
    });

    expect(firstPage.nextCursor).toContain('cursor=page-2');
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('cursor=page-2');
    expect(secondPage.models[0].id).toBe('org/model-2');
    expect(secondPage.nextCursor).toContain('cursor=page-3');
  });

  it('parses next links when quoted params contain commas and semicolons before rel', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=1&cursor=page-0>; rel="prev", <https://huggingface.co/api/models?search=phi%20gguf&limit=1&cursor=page-2>; title="cursor, page; two"; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([makeRepo('org/model-1')]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi', { pageSize: 1 });

    expect(result.models[0].id).toBe('org/model-1');
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toContain('cursor=page-2');
  });

  it('treats multi-token rel values as next when they include the next relation', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=1&cursor=page-2>; rel="prev next"'
              : null
          )),
        },
        json: () => Promise.resolve([makeRepo('org/model-1')]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi', { pageSize: 1 });

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toContain('cursor=page-2');
  });

  it('ignores untrusted search pagination links before they can receive auth headers', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn((headerName: string) => (
          headerName === 'link'
            ? '<https://example.com/api/models?cursor=steal-token>; rel="next"'
            : null
        )),
      },
      json: () => Promise.resolve([makeRepo('org/trusted-page-model')]),
    })) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi', { pageSize: 1 });

    expect(result.models[0].id).toBe('org/trusted-page-model');
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('https://huggingface.co/api/models');
  });

  it('returns only the requested page size and buffers overflow from later cursor pages', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=page-2')) {
        return Promise.resolve({
          ok: true,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            makeRepo('org/model-5'),
            makeRepo('org/model-6'),
            makeRepo('org/model-7'),
            makeRepo('org/model-8'),
            makeRepo('org/model-9'),
            makeRepo('org/model-10'),
            makeRepo('org/model-11'),
            makeRepo('org/model-12'),
            makeRepo('org/not-gguf-10', 1024, 'README.md'),
            makeRepo('org/not-gguf-11', 1024, 'README.md'),
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=20&cursor=page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([
          makeRepo('org/model-1'),
          makeRepo('org/model-2'),
          makeRepo('org/model-3'),
          makeRepo('org/model-4'),
          makeRepo('org/not-gguf-1', 1024, 'README.md'),
          makeRepo('org/not-gguf-2', 1024, 'README.md'),
          makeRepo('org/not-gguf-3', 1024, 'README.md'),
          makeRepo('org/not-gguf-4', 1024, 'README.md'),
          makeRepo('org/not-gguf-5', 1024, 'README.md'),
          makeRepo('org/not-gguf-6', 1024, 'README.md'),
        ]),
      });
    }) as jest.Mock;

    const firstPage = await modelCatalogService.searchModels('phi', { pageSize: 10 });

    expect(firstPage.models).toHaveLength(10);
    expect(firstPage.models.map((model) => model.id)).toEqual([
      'org/model-1',
      'org/model-2',
      'org/model-3',
      'org/model-4',
      'org/model-5',
      'org/model-6',
      'org/model-7',
      'org/model-8',
      'org/model-9',
      'org/model-10',
    ]);
    expect(firstPage.nextCursor).toMatch(/^catalog-buffer:/);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('limit=20');
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const secondPage = await modelCatalogService.searchModels('phi', {
      cursor: firstPage.nextCursor,
      pageSize: 10,
    });

    expect(secondPage.models).toHaveLength(2);
    expect(secondPage.models.map((model) => model.id)).toEqual([
      'org/model-11',
      'org/model-12',
    ]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('serves buffered cursor pages even after the normal cache TTL expires', async () => {
    const dateNowSpy = jest.spyOn(Date, 'now');
    dateNowSpy.mockReturnValue(1_000);

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=page-2')) {
        return Promise.resolve({
          ok: true,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            makeRepo('org/model-5'),
            makeRepo('org/model-6'),
            makeRepo('org/model-7'),
            makeRepo('org/model-8'),
            makeRepo('org/model-9'),
            makeRepo('org/model-10'),
            makeRepo('org/model-11'),
            makeRepo('org/model-12'),
            makeRepo('org/not-gguf-10', 1024, 'README.md'),
            makeRepo('org/not-gguf-11', 1024, 'README.md'),
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=20&cursor=page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([
          makeRepo('org/model-1'),
          makeRepo('org/model-2'),
          makeRepo('org/model-3'),
          makeRepo('org/model-4'),
          makeRepo('org/not-gguf-1', 1024, 'README.md'),
          makeRepo('org/not-gguf-2', 1024, 'README.md'),
          makeRepo('org/not-gguf-3', 1024, 'README.md'),
          makeRepo('org/not-gguf-4', 1024, 'README.md'),
          makeRepo('org/not-gguf-5', 1024, 'README.md'),
          makeRepo('org/not-gguf-6', 1024, 'README.md'),
        ]),
      });
    }) as jest.Mock;

    try {
      const firstPage = await modelCatalogService.searchModels('phi', { pageSize: 10 });

      dateNowSpy.mockReturnValue(1_000 + 10 * 60 * 1000);

      const secondPage = await modelCatalogService.searchModels('phi', {
        cursor: firstPage.nextCursor,
        pageSize: 10,
      });

      expect(secondPage.models.map((model) => model.id)).toEqual([
        'org/model-11',
        'org/model-12',
      ]);
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.nextCursor).toBeNull();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('invalidates the search cache when the Hugging Face token changes', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/token-aware-model')]),
      }),
    ) as jest.Mock;

    await modelCatalogService.searchModels('phi', { pageSize: 1 });
    await modelCatalogService.searchModels('phi', { pageSize: 1 });

    expect(global.fetch).toHaveBeenCalledTimes(1);

    await huggingFaceTokenService.saveToken('hf_test_token');
    await modelCatalogService.searchModels('phi', { pageSize: 1 });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toMatchObject({
      headers: {
        Authorization: 'Bearer hf_test_token',
      },
    });
  });

  it('persists model snapshots only once per fetched search page', async () => {
    const service = new ModelCatalogService();
    const putSnapshotsSpy = jest.spyOn((service as any).persistentCache, 'putModelSnapshots');
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/snapshot-write-model')]),
      }),
    ) as jest.Mock;

    try {
      await service.searchModels('phi', { pageSize: 10 });

      expect(putSnapshotsSpy).toHaveBeenCalledTimes(1);
    } finally {
      putSnapshotsSpy.mockRestore();
      service.dispose();
    }
  });

  it('caps detail variant arrays and in-memory model snapshots', async () => {
    const modelId = 'org/large-detail-variant-model';
    const siblings = Array.from({ length: CATALOG_SEARCH_VARIANT_LIMIT + 5 }, (_value, index) => ({
      rfilename: `model-${index.toString().padStart(2, '0')}.Q4_K_M.gguf`,
      size: (index + 1) * 1024 * 1024 * 1024,
    }));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: modelId,
          siblings,
        }),
      });
    }) as jest.Mock;

    const details = await modelCatalogService.getModelDetails(modelId);
    const cached = modelCatalogService.getCachedModel(modelId);

    expect(details.variants).toHaveLength(CATALOG_SEARCH_VARIANT_LIMIT);
    expect(cached?.variants).toHaveLength(CATALOG_SEARCH_VARIANT_LIMIT);
    expect(cached?.resolvedFileName).toBe(details.resolvedFileName);
    expect(cached?.variants?.some((variant) => variant.fileName === details.resolvedFileName)).toBe(true);
  });

  it('clears cached model snapshots when the Hugging Face token changes', async () => {
    const localModel = makeLocalModel('org/gated-model');
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
              size: 2 * 1024 * 1024 * 1024,
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeGatedRepo(localModel.id)]),
      });
    }) as jest.Mock;

    await modelCatalogService.searchModels('phi');

    expect(modelCatalogService.getCachedModel(localModel.id)?.accessState).toBe(ModelAccessState.AUTHORIZED);

    await huggingFaceTokenService.clearToken();

    expect(modelCatalogService.getCachedModel(localModel.id)?.accessState).toBe(ModelAccessState.PUBLIC);
  });

  it('does not reuse authorized snapshots after the token disappears outside mutation listeners', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }

      return Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          {
            id: 'org/external-token-model',
            gated: 'manual',
            siblings: [
              {
                rfilename: 'model.Q4_K_M.gguf',
                size: 2 * 1024 * 1024 * 1024,
              },
            ],
          },
        ]),
      });
    }) as jest.Mock;

    await modelCatalogService.searchModels('phi');

    await SecureStore.deleteItemAsync('huggingface-access-token');
    await huggingFaceTokenService.refreshState();

    const coldStartService = new ModelCatalogService();
    const cachedModel = coldStartService.getCachedModel('org/external-token-model');
    coldStartService.dispose();

    expect(cachedModel).toEqual(expect.objectContaining({
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
    }));
    expect(cachedModel?.resolvedFileName).toBeUndefined();
    expect(cachedModel?.variants).toBeUndefined();
  });

  it('does not write auth-derived gated snapshots into the anonymous cache', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    (modelCatalogService as any).persistentCache.putModelSnapshots([
      {
        ...makeLocalModel('org/gated-auth-search-model'),
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        localPath: undefined,
        resolvedFileName: 'stale-public.Q8_0.gguf',
        activeVariantId: 'stale-public.Q8_0.gguf',
        variants: [{
          variantId: 'stale-public.Q8_0.gguf',
          fileName: 'stale-public.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
        }],
      },
      {
        ...makeLocalModel('org/private-auth-search-model'),
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        localPath: undefined,
        resolvedFileName: 'stale-private.Q8_0.gguf',
        activeVariantId: 'stale-private.Q8_0.gguf',
        variants: [{
          variantId: 'stale-private.Q8_0.gguf',
          fileName: 'stale-private.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
        }],
      },
    ], 'anon');
    expect(modelCatalogService.getCachedModel('org/private-auth-search-model')).toEqual(expect.objectContaining({
      resolvedFileName: 'stale-private.Q8_0.gguf',
    }));

    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      headers: {
        get: jest.fn(() => null),
      },
      json: () => Promise.resolve([
        makeRepo('org/public-auth-search-model'),
        {
          ...makeRepo('org/gated-auth-search-model'),
          gated: 'manual',
        },
        {
          ...makeRepo('org/private-auth-search-model'),
          private: true,
        },
      ]),
    })) as jest.Mock;

    await modelCatalogService.searchModels('phi');
    await SecureStore.deleteItemAsync('huggingface-access-token');
    await huggingFaceTokenService.refreshState();
    expect(modelCatalogService.getCachedModel('org/private-auth-search-model')).toBeNull();

    const coldStartService = new ModelCatalogService();
    try {
      expect(coldStartService.getCachedModel('org/public-auth-search-model')?.accessState).toBe(ModelAccessState.PUBLIC);
      const gatedCachedModel = coldStartService.getCachedModel('org/gated-auth-search-model');
      expect(gatedCachedModel).toEqual(expect.objectContaining({
        accessState: ModelAccessState.AUTH_REQUIRED,
        isGated: true,
        isPrivate: false,
      }));
      expect(gatedCachedModel?.resolvedFileName).toBeUndefined();
      expect(gatedCachedModel?.activeVariantId).toBeUndefined();
      expect(gatedCachedModel?.variants).toBeUndefined();
      expect(coldStartService.getCachedModel('org/private-auth-search-model')).toBeNull();
    } finally {
      coldStartService.dispose();
    }
  });

  it('strips local runtime fields from auth-derived public anonymous in-memory snapshots', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    const modelId = 'org/public-auth-local-model';
    const localModel = {
      ...makeLocalModel(modelId),
      size: 1_500_000_000,
      resolvedFileName: 'model.Q4_K_M.gguf',
      activeVariantId: 'model.Q4_K_M.gguf',
      downloadUrl: 'https://huggingface.co/org/public-auth-local-model/resolve/main/model.Q4_K_M.gguf',
      metadataTrust: 'verified_local' as const,
      downloadIntegrity: {
        kind: 'size' as const,
        sizeBytes: 1_500_000_000,
        checkedAt: 123,
      },
      resumeData: JSON.stringify({ resumeData: 'private-resume-token' }),
      downloadedAt: 456,
    };
    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      headers: {
        get: jest.fn(() => null),
      },
      json: () => Promise.resolve([makeRepo(modelId, 1_500_000_000)]),
    })) as jest.Mock;

    await modelCatalogService.searchModels('phi');

    const cacheKey = (modelCatalogService as any).buildModelSnapshotCacheKey(modelId, 'anon');
    const anonymousSnapshot = (modelCatalogService as any).modelSnapshotCache.get(cacheKey);
    expect(anonymousSnapshot).toEqual(expect.objectContaining({
      id: modelId,
      accessState: ModelAccessState.PUBLIC,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    }));
    expect(anonymousSnapshot.localPath).toBeUndefined();
    expect(anonymousSnapshot.downloadedAt).toBeUndefined();
    expect(anonymousSnapshot.downloadIntegrity).toBeUndefined();
    expect(anonymousSnapshot.resumeData).toBeUndefined();
    expect(anonymousSnapshot.metadataTrust).not.toBe('verified_local');

    const mergedCachedModel = modelCatalogService.getCachedModel(modelId);
    expect(mergedCachedModel?.localPath).toBe(localModel.localPath);
    const recachedAnonymousSnapshot = (modelCatalogService as any).modelSnapshotCache.get(cacheKey);
    expect(recachedAnonymousSnapshot.localPath).toBeUndefined();
    expect(recachedAnonymousSnapshot.downloadIntegrity).toBeUndefined();
    expect(recachedAnonymousSnapshot.resumeData).toBeUndefined();
  });

  it('does not persist authenticated search queries into the anonymous cache', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    const sensitiveQuery = 'private-org/exact-repo';

    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      headers: {
        get: jest.fn(() => null),
      },
      json: () => Promise.resolve([makeRepo('org/public-auth-query-result')]),
    })) as jest.Mock;

    const result = await modelCatalogService.searchModels(sensitiveQuery);
    expect(result.models[0].id).toBe('org/public-auth-query-result');

    const persistentEntry = (modelCatalogService as any).persistentCache.getSearch(
      (modelCatalogService as any).buildPersistentSearchScope(sensitiveQuery, 20, null, false),
      Number.POSITIVE_INFINITY,
    );
    expect(persistentEntry).toBeNull();

    const coldStartService = new ModelCatalogService();
    try {
      expect(coldStartService.getCachedSearchResult(sensitiveQuery)).toBeNull();
    } finally {
      coldStartService.dispose();
    }
  });

  it('includes popularity metadata from Hugging Face list responses', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          {
            ...makeRepo('org/popular-model'),
            downloads: 1234,
            likes: 56,
            tags: ['gguf', 'chat'],
          },
        ]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0].downloads).toBe(1234);
    expect(result.models[0].likes).toBe(56);
    expect(result.models[0].tags).toBeUndefined();
  });

  it('passes Hugging Face server-side sort parameters for most-downloaded ordering', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/top-download-model')]),
      }),
    ) as jest.Mock;

    await modelCatalogService.searchModels('phi', {
      pageSize: 10,
      sort: 'downloads',
    });

    const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(firstUrl).toContain('sort=downloads');
    expect(firstUrl).toContain('direction=-1');
  });

  it('passes Hugging Face server-side sort parameters for most-popular ordering', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/top-liked-model')]),
      }),
    ) as jest.Mock;

    await modelCatalogService.searchModels('phi', {
      pageSize: 10,
      sort: 'likes',
    });

    const firstUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(firstUrl).toContain('sort=likes');
    expect(firstUrl).toContain('direction=-1');
  });

  it('builds revision-aware download URLs and URL-encodes GGUF file paths', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRevisionRepo('org/revision-model')]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0].hfRevision).toBe('cafebabe1234');
    expect(result.models[0].downloadUrl).toBe(
      'https://huggingface.co/org/revision-model/resolve/cafebabe1234/folder/model%20Q4%2B%23.gguf',
    );
  });

  it('uses the resolved revision instead of main for tree and README lookups', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/tree/cafebabe1234?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([
            {
              path: 'folder/model Q4+#.gguf',
              size: 2 * 1024 * 1024 * 1024,
            },
          ]),
        });
      }

      if (url.endsWith('/raw/cafebabe1234/README.md')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# Model\n\nRevision scoped README summary text.'),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 'org/revision-detail-model',
          sha: 'cafebabe1234',
          siblings: [
            {
              rfilename: 'folder/model Q4+#.gguf',
            },
          ],
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/revision-detail-model');
    const fetchCalls = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));

    expect(result.hfRevision).toBe('cafebabe1234');
    expect(result.downloadUrl).toBe(
      'https://huggingface.co/org/revision-detail-model/resolve/cafebabe1234/folder/model%20Q4%2B%23.gguf',
    );
    expect(result.description).toBe('Revision scoped README summary text.');
    expect(fetchCalls).toContain(
      'https://huggingface.co/api/models/org/revision-detail-model/tree/cafebabe1234?recursive=true',
    );
    expect(fetchCalls).toContain(
      'https://huggingface.co/org/revision-detail-model/raw/cafebabe1234/README.md',
    );
    expect(fetchCalls.some((url) => url.includes('/tree/main?recursive=true'))).toBe(false);
    expect(fetchCalls.some((url) => url.endsWith('/raw/main/README.md'))).toBe(false);
  });

  it('preserves Gemma MTP through projector-aware full-tree model details', async () => {
    const modelId = 'unsloth/gemma-4-12b-it-GGUF';
    const revision = 'gemma-mtp-revision';
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const entries = [
        { path: 'gemma-4-12b-it-Q4_K_M.gguf', size: 7_000_000_000 },
        { path: 'mmproj-gemma-4-f16.gguf', size: 800_000_000 },
        { path: 'MTP/gemma-4-12b-it-MTP-Q8_0.gguf', size: 465_000_000 },
      ];

      if (url.includes(`/tree/${revision}?recursive=true`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          json: () => Promise.resolve(entries),
        });
      }
      if (url.endsWith(`/raw/${revision}/README.md`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('# Gemma 4\n\nProjector-aware MTP model.'),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: modelId,
          sha: revision,
          tags: ['gguf', 'gemma', 'vision'],
          siblings: entries.map(({ path, size }) => ({ rfilename: path, size })),
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails(modelId);
    const draft = result.artifacts?.find((artifact) => artifact.kind === 'speculative_draft');
    const activeVariant = result.variants?.find((variant) => (
      variant.fileName === 'gemma-4-12b-it-Q4_K_M.gguf'
    ));

    expect(result.projectorCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: 'mmproj-gemma-4-f16.gguf' }),
    ]));
    expect(draft).toEqual(expect.objectContaining({
      remoteFileName: 'MTP/gemma-4-12b-it-MTP-Q8_0.gguf',
      sizeBytes: 465_000_000,
    }));
    expect(activeVariant?.speculativeDecoding).toEqual(expect.objectContaining({
      mode: 'draft_model',
      draftArtifactId: draft?.id,
    }));
    expect(result.speculativeDecoding).toEqual(activeVariant?.speculativeDecoding);
  });

  it('URL-encodes revisions that contain slashes for tree, raw, and resolve URLs', async () => {
    const revision = 'refs/pr/1';
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/tree/refs%2Fpr%2F1?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([
            {
              path: 'folder/model Q4+#.gguf',
              size: 2 * 1024 * 1024 * 1024,
            },
          ]),
        });
      }

      if (url.endsWith('/raw/refs%2Fpr%2F1/README.md')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('# Model\n\nSlash revision README summary text.'),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 'org/slash-revision-detail-model',
          sha: revision,
          siblings: [
            {
              rfilename: 'folder/model Q4+#.gguf',
            },
          ],
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/slash-revision-detail-model');
    const fetchCalls = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));

    expect(result.hfRevision).toBe(revision);
    expect(result.downloadUrl).toBe(
      'https://huggingface.co/org/slash-revision-detail-model/resolve/refs%2Fpr%2F1/folder/model%20Q4%2B%23.gguf',
    );
    expect(fetchCalls).toContain(
      'https://huggingface.co/api/models/org/slash-revision-detail-model/tree/refs%2Fpr%2F1?recursive=true',
    );
    expect(fetchCalls).toContain(
      'https://huggingface.co/org/slash-revision-detail-model/raw/refs%2Fpr%2F1/README.md',
    );
  });

  it('loads README summary text for model details', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve([
            '---',
            'license: apache-2.0',
            '---',
            '',
            '# Model',
            '',
            'This is a concise description for the model details screen.',
            '',
            '## Extra',
          ].join('\n')),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo('org/detail-model'),
          downloads: 88,
          likes: 7,
          tags: ['gguf', 'assistant'],
          config: {
            model_type: 'llama',
          },
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/detail-model');

    expect(result.description).toBe('This is a concise description for the model details screen.');
    expect(result.downloads).toBe(88);
    expect(result.likes).toBe(7);
    expect(result.tags).toEqual(['gguf', 'assistant']);
  });

  it('retries README fetches with auth when gated repos hide anonymous README as 404', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authHeader = (init?.headers as { Authorization?: string } | undefined)?.Authorization;

      if (url.includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }

      if (url.endsWith('/raw/main/README.md')) {
        if (authHeader === 'Bearer hf_test_token') {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve('# Model\n\nAuthenticated README summary.'),
          });
        }

        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          ...makeRepo('org/gated-readme-model'),
          gated: 'manual',
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/gated-readme-model');
    const readmeCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).endsWith('/raw/main/README.md'));

    expect(result.description).toBe('Authenticated README summary.');
    expect(readmeCalls).toHaveLength(2);
    expect(readmeCalls[0]?.[1]?.headers).toBeUndefined();
    expect(readmeCalls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Bearer hf_test_token',
      },
    });
  });

  it('hydrates additional metadata from Hugging Face cardData and README front matter', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve([
            '---',
            'context_length: 65536',
            'license: apache-2.0',
            'datasets:',
            '  - ultrachat_200k',
            'model_creator: Meta',
            '---',
            '',
            '# Model',
            '',
            'A detailed model card.',
          ].join('\n')),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo('org/rich-detail-model'),
          gguf: {
            size_label: '8B',
          },
          cardData: {
            base_model: ['meta-llama/Llama-3.1-8B-Instruct'],
            language: ['en', 'de'],
            quantized_by: 'bartowski',
            model_type: 'llama',
          },
          config: {
            max_position_embeddings: 8192,
            rope_scaling: {
              original_max_position_embeddings: 32768,
            },
            architectures: ['LlamaForCausalLM'],
          },
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/rich-detail-model');

    expect(result.parameterSizeLabel).toBe('8B');
    expect(result.modelType).toBe('llama');
    expect(result.architectures).toEqual(['LlamaForCausalLM']);
    expect(result.baseModels).toEqual(['meta-llama/Llama-3.1-8B-Instruct']);
    expect(result.license).toBe('apache-2.0');
    expect(result.languages).toEqual(['en', 'de']);
    expect(result.datasets).toEqual(['ultrachat_200k']);
    expect(result.quantizedBy).toBe('bartowski');
    expect(result.modelCreator).toBe('Meta');
    expect(result.maxContextTokens).toBe(65536);
  });

  it('hydrates parameter size labels from Hugging Face summary gguf metadata', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          {
            ...makeRepo('org/summary-size-label-model'),
            gguf: {
              total: 1.5 * 1024 * 1024 * 1024,
              architecture: 'llama',
              size_label: '14B',
            },
          },
        ]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('summary-size-label-model');

    expect(result.models[0]).toEqual(expect.objectContaining({
      id: 'org/summary-size-label-model',
      parameterSizeLabel: undefined,
    }));
  });

  it('hydrates context ceilings from README front matter even when no summary or cardData is present', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve([
            '---',
            'context_length: 65536',
            '---',
            '',
          ].join('\n')),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeRepo('org/readme-context-only-model')),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/readme-context-only-model');

    expect(result.maxContextTokens).toBe(65536);
  });

  it('parses 32k-style context ceilings from README front matter', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve([
            '---',
            'context_length: 32k',
            '---',
            '',
          ].join('\n')),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeRepo('org/readme-context-shorthand-model')),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/readme-context-shorthand-model');

    expect(result.maxContextTokens).toBe(32768);
    expect(result.hasVerifiedContextWindow).toBe(true);
  });

  it('keeps the largest available context ceiling from nested Hugging Face config metadata', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo('org/long-context-detail-model'),
          config: {
            max_position_embeddings: 8192,
            text_config: {
              model_max_length: 32768,
            },
            rope_scaling: {
              original_max_position_embeddings: 65536,
            },
          },
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/long-context-detail-model');

    expect(result.maxContextTokens).toBe(65536);
  });

  it('keeps fallback context ceilings unverified when detail sources do not expose them', async () => {
    const service = new ModelCatalogService();
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/unverified-fallback-context-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 1.5 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q4_K_M.gguf',
      maxContextTokens: 32768,
      hasVerifiedContextWindow: false,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeRepo(localModel.id)),
      });
    }) as jest.Mock;

    const result = await service.getModelDetails(localModel.id);

    expect(result.maxContextTokens).toBe(32768);
    expect(result.hasVerifiedContextWindow).toBe(false);
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: localModel.id,
      maxContextTokens: 32768,
      hasVerifiedContextWindow: false,
    }));

    service.dispose();
  });

  it('prefers fresher verified detail context ceilings over stale verified local metadata', async () => {
    const service = new ModelCatalogService();
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/stale-verified-context-model'),
      accessState: ModelAccessState.PUBLIC,
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo(localModel.id),
          config: {
            max_position_embeddings: 8192,
          },
        }),
      });
    }) as jest.Mock;

    const result = await service.getModelDetails(localModel.id);

    expect(result.maxContextTokens).toBe(8192);
    expect(result.hasVerifiedContextWindow).toBe(true);
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: localModel.id,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    }));

    service.dispose();
  });

  it('preserves verified local detail metadata when the remote digest is missing', async () => {
    const service = new ModelCatalogService();
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/detail-missing-digest-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
      downloadedAt: 123456,
      resumeData: JSON.stringify({ resumeData: 'stale' }),
      downloadErrorAt: 234567,
      downloadErrorCode: 'download_http_error',
      downloadErrorMessage: 'stale failure',
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo(localModel.id, 4 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 4 * 1024 * 1024 * 1024,
          }],
        }),
      });
    }) as jest.Mock;

    const result = await service.getModelDetails(localModel.id);

    expect(result).toEqual(expect.objectContaining({
      id: localModel.id,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
    }));
    expect(result.downloadIntegrity).toEqual(localModel.downloadIntegrity);
    expect(result.gguf).toEqual(expect.objectContaining({
      totalBytes: 4 * 1024 * 1024 * 1024,
      architecture: 'llama',
      nLayers: 40,
    }));
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: localModel.id,
      sha256: LOCAL_SHA256,
      downloadIntegrity: localModel.downloadIntegrity,
      metadataTrust: 'verified_local',
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
    }));

    service.dispose();
  });

  it('preserves size-only integrity markers through compatible detail sync', async () => {
    const service = new ModelCatalogService();
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/detail-size-integrity-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 3 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q4_K_M.gguf',
      localPath: 'detail-size-integrity-model.gguf',
      metadataTrust: 'trusted_remote',
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: 3 * 1024 * 1024 * 1024,
        checkedAt: 123,
      },
      gguf: {
        totalBytes: 3 * 1024 * 1024 * 1024,
      },
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 3 * 1024 * 1024 * 1024,
          }],
        }),
      });
    }) as jest.Mock;

    const result = await service.getModelDetails(localModel.id);

    expect(result).toEqual(expect.objectContaining({
      id: localModel.id,
      localPath: localModel.localPath,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      metadataTrust: 'trusted_remote',
      sha256: undefined,
    }));
    expect(result.downloadIntegrity).toEqual(localModel.downloadIntegrity);
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: localModel.id,
      localPath: localModel.localPath,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadIntegrity: localModel.downloadIntegrity,
      metadataTrust: 'trusted_remote',
    }));

    service.dispose();
  });

  it('resets size-only downloaded state when the stored local sha conflicts with a new remote sha', async () => {
    const service = new ModelCatalogService();
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/detail-size-integrity-sha-conflict-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 3 * 1024 * 1024 * 1024,
      resolvedFileName: 'model.Q4_K_M.gguf',
      localPath: 'detail-size-integrity-sha-conflict-model.gguf',
      sha256: LOCAL_SHA256,
      metadataTrust: 'trusted_remote',
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: 3 * 1024 * 1024 * 1024,
        checkedAt: 123,
      },
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 3 * 1024 * 1024 * 1024,
            lfs: { sha256: OTHER_TREE_SHA256 },
          }],
        }),
      });
    }) as jest.Mock;

    const result = await service.getModelDetails(localModel.id);

    expect(result).toEqual(expect.objectContaining({
      id: localModel.id,
      localPath: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      sha256: OTHER_TREE_SHA256,
      metadataTrust: 'trusted_remote',
    }));
    expect(result.downloadIntegrity).toBeUndefined();
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: localModel.id,
      localPath: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      sha256: OTHER_TREE_SHA256,
    }));
    expect(mockedRegistry.updateModel.mock.calls.at(-1)?.[0].downloadIntegrity).toBeUndefined();

    service.dispose();
  });

  it('drops stale verified local detail metadata when the remote digest changes', async () => {
    const service = new ModelCatalogService();
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/stale-detail-digest-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      sha256: LOCAL_SHA256,
      metadataTrust: 'verified_local',
      downloadIntegrity: {
        kind: 'sha256',
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 123,
        sha256: LOCAL_SHA256,
      },
      gguf: {
        totalBytes: 4 * 1024 * 1024 * 1024,
        architecture: 'llama',
        nLayers: 40,
      },
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo(localModel.id, 3 * 1024 * 1024 * 1024),
          siblings: [{
            rfilename: 'model.Q4_K_M.gguf',
            size: 3 * 1024 * 1024 * 1024,
            lfs: { sha256: OTHER_TREE_SHA256 },
          }],
        }),
      });
    }) as jest.Mock;

    const result = await service.getModelDetails(localModel.id);

    expect(result).toEqual(expect.objectContaining({
      id: localModel.id,
      size: 3 * 1024 * 1024 * 1024,
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      resumeData: undefined,
      downloadErrorAt: undefined,
      downloadErrorCode: undefined,
      downloadErrorMessage: undefined,
      sha256: OTHER_TREE_SHA256,
      metadataTrust: 'trusted_remote',
      maxContextTokens: undefined,
      hasVerifiedContextWindow: false,
    }));
    expect(result.downloadIntegrity).toBeUndefined();
    expect(result.gguf?.totalBytes).toBe(3 * 1024 * 1024 * 1024);
    expect(result.gguf?.architecture).toBeUndefined();
    expect(result.gguf?.nLayers).toBeUndefined();

    service.dispose();
  });

  it('does not send Authorization headers on the model details request when a token is configured', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 'org/detail-no-auth-header',
          gated: 'manual',
          siblings: [
            {
              rfilename: 'model.Q4_K_M.gguf',
              size: 2 * 1024 * 1024 * 1024,
            },
          ],
        }),
      });
    }) as jest.Mock;

    await modelCatalogService.getModelDetails('org/detail-no-auth-header');

    const calls = (global.fetch as jest.Mock).mock.calls;
    const detailsCall = calls.find((call) => String(call[0]).includes('/api/models/org/detail-no-auth-header'));
    expect(detailsCall?.[1]?.headers).toBeUndefined();

    const probeCall = calls.find((call) => String(call[0]).includes('/resolve/main/model.Q4_K_M.gguf'));
    expect(probeCall?.[1]).toMatchObject({
      method: 'HEAD',
      headers: {
        Authorization: 'Bearer hf_test_token',
      },
    });
  });

  it('retries model details with Authorization when the anonymous request returns 404', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      if (url.includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }

      if (url.includes('/api/models/org/detail-requires-auth')) {
        if ((init?.headers as { Authorization?: string } | undefined)?.Authorization === 'Bearer hf_test_token') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              id: 'org/detail-requires-auth',
              gated: 'manual',
              siblings: [
                {
                  rfilename: 'model.Q4_K_M.gguf',
                  size: 2 * 1024 * 1024 * 1024,
                },
              ],
            }),
          });
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        });
      }

      return Promise.resolve({
        ok: false,
        status: 404,
      });
    }) as jest.Mock;

    await modelCatalogService.getModelDetails('org/detail-requires-auth');

    const detailsCalls = (global.fetch as jest.Mock).mock.calls.filter((call) => (
      String(call[0]).includes('/api/models/org/detail-requires-auth')
    ));

    expect(detailsCalls).toHaveLength(2);
    expect(detailsCalls[0]?.[1]?.headers).toBeUndefined();
    expect(detailsCalls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Bearer hf_test_token',
      },
    });
  });

  it('reconciles stale anonymous caches when authenticated details become non-public', async () => {
    const modelId = 'org/detail-requires-auth-cache';
    const staleAnonModel: ModelMetadata = {
      ...makeLocalModel(modelId),
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      localPath: undefined,
      resolvedFileName: 'stale-public.Q8_0.gguf',
      activeVariantId: 'stale-public.Q8_0.gguf',
      variants: [{
        variantId: 'stale-public.Q8_0.gguf',
        fileName: 'stale-public.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000_000_000,
      }],
    };
    (modelCatalogService as any).persistentCache.putModelSnapshots([staleAnonModel], 'anon');
    (modelCatalogService as any).persistentCache.putSearch(
      (modelCatalogService as any).buildPersistentSearchScope('detail gguf', 10, null, false),
      {
        models: [staleAnonModel],
        hasMore: false,
        nextCursor: null,
      },
    );
    expect(modelCatalogService.getCachedModel(modelId)?.resolvedFileName).toBe('stale-public.Q8_0.gguf');

    await huggingFaceTokenService.saveToken('hf_test_token');
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      if (url.includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }

      if (url.includes(`/api/models/${modelId}`)) {
        if ((init?.headers as { Authorization?: string } | undefined)?.Authorization === 'Bearer hf_test_token') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              id: modelId,
              gated: 'manual',
              siblings: [
                {
                  rfilename: 'model.Q4_K_M.gguf',
                  size: 2 * 1024 * 1024 * 1024,
                },
              ],
            }),
          });
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        });
      }

      return Promise.resolve({
        ok: false,
        status: 404,
      });
    }) as jest.Mock;

    await modelCatalogService.getModelDetails(modelId);
    await SecureStore.deleteItemAsync('huggingface-access-token');
    await huggingFaceTokenService.refreshState();

    const coldStartService = new ModelCatalogService();
    try {
      const cachedModel = coldStartService.getCachedModel(modelId);
      expect(cachedModel).toEqual(expect.objectContaining({
        accessState: ModelAccessState.AUTH_REQUIRED,
        isGated: true,
        isPrivate: false,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
      }));
      expect(cachedModel?.resolvedFileName).toBeUndefined();
      expect(cachedModel?.activeVariantId).toBeUndefined();
      expect(cachedModel?.variants).toBeUndefined();

      const cachedSearch = coldStartService.getCachedSearchResult('detail', { pageSize: 10 });
      expect(cachedSearch?.models).toEqual([
        expect.objectContaining({
          id: modelId,
          accessState: ModelAccessState.AUTH_REQUIRED,
          isGated: true,
        }),
      ]);
      expect(cachedSearch?.models[0]?.resolvedFileName).toBeUndefined();
      expect(cachedSearch?.models[0]?.activeVariantId).toBeUndefined();
      expect(cachedSearch?.models[0]?.variants).toBeUndefined();
    } finally {
      coldStartService.dispose();
    }
  });

  it('reconciles stale anonymous caches when anonymous details return a gated model', async () => {
    const modelId = 'org/detail-anon-gated-cache';
    const staleAnonModel: ModelMetadata = {
      ...makeLocalModel(modelId),
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      localPath: undefined,
      resolvedFileName: 'stale-public.Q8_0.gguf',
      activeVariantId: 'stale-public.Q8_0.gguf',
      variants: [{
        variantId: 'stale-public.Q8_0.gguf',
        fileName: 'stale-public.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: 8_000_000_000,
      }],
    };
    (modelCatalogService as any).persistentCache.putModelSnapshots([staleAnonModel], 'anon');
    (modelCatalogService as any).persistentCache.putSearch(
      (modelCatalogService as any).buildPersistentSearchScope('detail gguf', 10, null, false),
      {
        models: [staleAnonModel],
        hasMore: false,
        nextCursor: null,
      },
    );
    expect(modelCatalogService.getCachedModel(modelId)?.resolvedFileName).toBe('stale-public.Q8_0.gguf');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      if (url.includes(`/api/models/${modelId}`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: modelId,
            gated: 'manual',
            siblings: [
              {
                rfilename: 'model.Q4_K_M.gguf',
                size: 2 * 1024 * 1024 * 1024,
              },
            ],
          }),
        });
      }

      return Promise.resolve({
        ok: false,
        status: 404,
      });
    }) as jest.Mock;

    await modelCatalogService.getModelDetails(modelId);

    const coldStartService = new ModelCatalogService();
    try {
      const cachedModel = coldStartService.getCachedModel(modelId);
      expect(cachedModel).toEqual(expect.objectContaining({
        id: modelId,
        accessState: ModelAccessState.AUTH_REQUIRED,
        isGated: true,
        isPrivate: false,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
      }));
      expect(cachedModel?.resolvedFileName).toBeUndefined();
      expect(cachedModel?.activeVariantId).toBeUndefined();
      expect(cachedModel?.variants).toBeUndefined();

      const cachedSearch = coldStartService.getCachedSearchResult('detail', { pageSize: 10 });
      expect(cachedSearch?.models).toEqual([
        expect.objectContaining({
          id: modelId,
          accessState: ModelAccessState.AUTH_REQUIRED,
          isGated: true,
        }),
      ]);
      expect(cachedSearch?.models[0]?.resolvedFileName).toBeUndefined();
      expect(cachedSearch?.models[0]?.activeVariantId).toBeUndefined();
      expect(cachedSearch?.models[0]?.variants).toBeUndefined();
    } finally {
      coldStartService.dispose();
    }
  });

  it('keeps gated model details auth-required when the anonymous request returns 404 without a token', async () => {
    const cachedModel: ModelMetadata = {
      id: 'org/detail-gated-no-token',
      name: 'detail-gated-no-token',
      author: 'org',
      size: null,
      downloadUrl: 'https://example.com/org/detail-gated-no-token/model.Q4_K_M.gguf',
      fitsInRam: null,
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    };

    const cachedModelSpy = jest.spyOn(modelCatalogService, 'getCachedModel').mockImplementation((modelId) => (
      modelId === cachedModel.id ? cachedModel : null
    ));

    try {
      global.fetch = jest.fn((input: RequestInfo | URL) => {
        const url = String(input);

        if (url.endsWith('/raw/main/README.md')) {
          return Promise.resolve({
            ok: false,
            status: 404,
            text: () => Promise.resolve(''),
          });
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        });
      }) as jest.Mock;

      const result = await modelCatalogService.getModelDetails(cachedModel.id);
      expect(result.accessState).toBe(ModelAccessState.AUTH_REQUIRED);
    } finally {
      cachedModelSpy.mockRestore();
    }
  });

  it('throws when a public model returns 404 even after an auth retry', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    const cachedModel: ModelMetadata = {
      id: 'org/detail-missing-public',
      name: 'detail-missing-public',
      author: 'org',
      size: null,
      downloadUrl: 'https://example.com/org/detail-missing-public/model.Q4_K_M.gguf',
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    };

    const cachedModelSpy = jest.spyOn(modelCatalogService, 'getCachedModel').mockImplementation((modelId) => (
      modelId === cachedModel.id ? cachedModel : null
    ));

    try {
      global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.includes('/api/models/org/detail-missing-public')) {
          const authHeader = (init?.headers as { Authorization?: string } | undefined)?.Authorization;
          return Promise.resolve({
            ok: false,
            status: 404,
            headers: authHeader ? { Authorization: authHeader } : undefined,
          });
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        });
      }) as jest.Mock;

      await expect(modelCatalogService.getModelDetails(cachedModel.id)).rejects.toMatchObject({
        code: 'network',
      });

      const detailsCalls = (global.fetch as jest.Mock).mock.calls.filter((call) => (
        String(call[0]).includes('/api/models/org/detail-missing-public')
      ));
      expect(detailsCalls).toHaveLength(2);
      expect(detailsCalls[0]?.[1]?.headers).toBeUndefined();
      expect(detailsCalls[1]?.[1]).toMatchObject({
        headers: {
          Authorization: 'Bearer hf_test_token',
        },
      });
    } finally {
      cachedModelSpy.mockRestore();
    }
  });

  it('keeps gated model details authorized when later access validation is temporarily unavailable', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: false,
          status: 429,
        });
      }

      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve([]),
        });
      }

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 'org/detail-gated-model',
          gated: 'manual',
          siblings: [
            {
              rfilename: 'model.Q4_K_M.gguf',
              size: 2 * 1024 * 1024 * 1024,
            },
          ],
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/detail-gated-model');

    expect(result.accessState).toBe(ModelAccessState.AUTHORIZED);
  });

  it('does not treat auth fallbacks as verified context metadata for downloaded gated models', async () => {
    const service = new ModelCatalogService();
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/detail-gated-local-model'),
      accessState: ModelAccessState.AUTHORIZED,
      isGated: true,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: false,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === localModel.id ? localModel : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 403,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: false,
        status: 401,
      });
    }) as jest.Mock;

    const result = await service.getModelDetails(localModel.id);

    expect(result.accessState).toBe(ModelAccessState.AUTH_REQUIRED);
    expect(result.maxContextTokens).toBe(8192);
    expect(result.hasVerifiedContextWindow).toBe(false);
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: localModel.id,
      hasVerifiedContextWindow: false,
      maxContextTokens: 8192,
    }));

    service.dispose();
  });

  it('retries model details when the auth token changes mid-flight and keeps only the fresh snapshot', async () => {
    await huggingFaceTokenService.saveToken('hf_token_a');
    const firstDetails = createDeferred<any>();
    const service = new ModelCatalogService();
    let apiCallCount = 0;

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      apiCallCount += 1;
      if (apiCallCount === 1) {
        return firstDetails.promise;
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo('org/detail-race-model'),
          id: 'org/detail-race-model',
          downloads: 99,
        }),
      });
    }) as jest.Mock;

    const pendingResult = service.getModelDetails('org/detail-race-model');
    await waitForMockCallCount(global.fetch as jest.Mock, 1);
    await huggingFaceTokenService.saveToken('hf_token_b');
    firstDetails.resolve({
      ok: true,
      json: () => Promise.resolve({
        ...makeRepo('org/detail-race-model'),
        id: 'org/detail-race-model',
        downloads: 1,
      }),
    });

    const result = await pendingResult;
    const coldStartService = new ModelCatalogService();
    const cachedModel = coldStartService.getCachedModel('org/detail-race-model');

    expect(result.downloads).toBe(99);
    expect(cachedModel?.downloads).toBe(99);
    expect(apiCallCount).toBe(2);

    coldStartService.dispose();
    service.dispose();
  });

  it('does not retry model details across a manual clear after the token changes', async () => {
    await huggingFaceTokenService.saveToken('hf_token_a');
    const firstDetails = createDeferred<Response>();
    const service = new ModelCatalogService();
    let detailsRequestCount = 0;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }
      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          json: () => Promise.resolve([]),
        });
      }

      detailsRequestCount += 1;
      if (detailsRequestCount === 1) {
        return firstDetails.promise;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve(makeRepo('org/details-auth-clear-race')),
      });
    }) as jest.Mock;

    const pendingDetails = service.getModelDetails('org/details-auth-clear-race');
    await waitForMockCallCount(global.fetch as jest.Mock, 1);
    await huggingFaceTokenService.saveToken('hf_token_b');
    service.clearCache('manual');
    firstDetails.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve(makeRepo('org/details-auth-clear-race')),
    } as unknown as Response);

    await expect(pendingDetails).rejects.toMatchObject({ code: 'cancelled' });
    expect(detailsRequestCount).toBe(1);
    expect(service.getCachedModel('org/details-auth-clear-race')).toBeNull();
    service.dispose();
  });

  it('does not retry metadata refresh across a manual clear after the token changes', async () => {
    await huggingFaceTokenService.saveToken('hf_token_a');
    const firstTree = createDeferred<Response>();
    const service = new ModelCatalogService();
    const refreshTarget: ModelMetadata = {
      id: 'org/refresh-auth-clear-race',
      name: 'refresh-auth-clear-race',
      author: 'org',
      size: null,
      downloadUrl: 'https://huggingface.co/org/refresh-auth-clear-race/resolve/main/model.gguf',
      resolvedFileName: 'model.gguf',
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: true,
      hasVerifiedContextWindow: true,
    };
    let treeRequestCount = 0;
    global.fetch = jest.fn(() => {
      treeRequestCount += 1;
      if (treeRequestCount === 1) {
        return firstTree.promise;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([{
          path: 'model.gguf',
          size: 2 * 1024 * 1024 * 1024,
        }]),
      });
    }) as jest.Mock;

    const pendingRefresh = service.refreshModelMetadata(refreshTarget, {
      includeDetails: false,
    });
    await waitForMockCallCount(global.fetch as jest.Mock, 1);
    await huggingFaceTokenService.saveToken('hf_token_b');
    service.clearCache('manual');
    firstTree.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([{
        path: 'model.gguf',
        size: 1 * 1024 * 1024 * 1024,
      }]),
    } as unknown as Response);

    await expect(pendingRefresh).rejects.toMatchObject({ code: 'cancelled' });
    expect(treeRequestCount).toBe(1);
    expect(service.getCachedModel(refreshTarget.id)).toBeNull();
    service.dispose();
  });

  it('hydrates recent model details from persisted snapshots across service instances', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve([
            '---',
            'license: apache-2.0',
            '---',
            '',
            '# Model',
            '',
            'A portable cached description.',
          ].join('\n')),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo('org/persisted-detail-model'),
          cardData: {
            model_type: 'llama',
            quantized_by: 'bartowski',
          },
          config: {
            architectures: ['LlamaForCausalLM'],
          },
        }),
      });
    }) as jest.Mock;

    await modelCatalogService.getModelDetails('org/persisted-detail-model');

    const coldStartService = new ModelCatalogService();
    const cachedModel = coldStartService.getCachedModel('org/persisted-detail-model');
    coldStartService.dispose();

    expect(cachedModel?.description).toBe('A portable cached description.');
    expect(cachedModel?.license).toBe('apache-2.0');
    expect(cachedModel?.modelType).toBe('llama');
    expect(cachedModel?.quantizedBy).toBe('bartowski');
  });

  it('refreshes stale context ceilings for known-size public models through the detail endpoint', async () => {
    const service = new ModelCatalogService();
    const refreshTarget: ModelMetadata = {
      id: 'org/stale-context-model',
      name: 'stale-context-model',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/stale-context-model/resolve/main/model.gguf',
      resolvedFileName: 'model.gguf',
      localPath: 'stale-context-model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: false,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === refreshTarget.id ? refreshTarget : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo('org/stale-context-model', 2 * 1024 * 1024 * 1024, 'model.gguf'),
          config: {
            max_position_embeddings: 8192,
            rope_scaling: {
              original_max_position_embeddings: 32768,
            },
          },
        }),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(refreshTarget);

    expect(refreshed.maxContextTokens).toBe(32768);
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: refreshTarget.id,
      localPath: refreshTarget.localPath,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
    }));
    expect((global.fetch as jest.Mock).mock.calls.some(([input]) => (
      String(input).includes('/api/models/org/stale-context-model')
    ))).toBe(true);

    service.dispose();
  });

  it('refreshes unverified long context ceilings through the detail endpoint even above the default threshold', async () => {
    const service = new ModelCatalogService();
    const refreshTarget: ModelMetadata = {
      id: 'org/stale-long-context-model',
      name: 'stale-long-context-model',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/stale-long-context-model/resolve/main/model.gguf',
      resolvedFileName: 'model.gguf',
      localPath: 'stale-long-context-model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      maxContextTokens: 32768,
      hasVerifiedContextWindow: false,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === refreshTarget.id ? refreshTarget : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo('org/stale-long-context-model', 2 * 1024 * 1024 * 1024),
          config: {
            rope_scaling: {
              original_max_position_embeddings: 65536,
            },
          },
        }),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(refreshTarget);

    expect(refreshed.maxContextTokens).toBe(65536);
    expect(refreshed.hasVerifiedContextWindow).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls.some(([input]) => (
      String(input).includes('/api/models/org/stale-long-context-model')
    ))).toBe(true);

    service.dispose();
  });

  it('refreshes context ceilings for size-less local models through the detail endpoint in a single pass', async () => {
    const service = new ModelCatalogService();
    const refreshTarget: ModelMetadata = {
      id: 'org/size-less-context-model',
      name: 'size-less-context-model',
      author: 'org',
      size: null,
      downloadUrl: 'https://huggingface.co/org/size-less-context-model/resolve/main/model.gguf',
      resolvedFileName: 'model.gguf',
      localPath: 'size-less-context-model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: false,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === refreshTarget.id ? refreshTarget : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ...makeRepo('org/size-less-context-model', 2 * 1024 * 1024 * 1024, 'model.gguf'),
          config: {
            rope_scaling: {
              original_max_position_embeddings: 32768,
            },
          },
        }),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(refreshTarget);

    expect(refreshed.size).toBe(2 * 1024 * 1024 * 1024);
    expect(refreshed.maxContextTokens).toBe(32768);
    expect(refreshed.hasVerifiedContextWindow).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls.some(([input]) => (
      String(input).includes('/tree/')
    ))).toBe(false);

    service.dispose();
  });

  it('refreshes stale context ceilings for gated models through the detail endpoint when a token is available', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    const service = new ModelCatalogService();
    const refreshTarget: ModelMetadata = {
      id: 'org/stale-gated-context-model',
      name: 'stale-gated-context-model',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/stale-gated-context-model/resolve/main/model.gguf',
      resolvedFileName: 'model.gguf',
      localPath: 'stale-gated-context-model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: false,
    };
    mockedRegistry.getModel.mockImplementation((modelId: string) => (
      modelId === refreshTarget.id ? refreshTarget : undefined
    ));

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve(''),
        });
      }

      if (url.includes('/api/models/org/stale-gated-context-model')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ...makeRepo('org/stale-gated-context-model', 2 * 1024 * 1024 * 1024, 'model.gguf'),
            gated: 'manual',
            config: {
              max_position_embeddings: 8192,
              rope_scaling: {
                original_max_position_embeddings: 32768,
              },
            },
          }),
        });
      }

      if (url.includes('/resolve/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(refreshTarget);

    expect(refreshed.accessState).toBe(ModelAccessState.AUTHORIZED);
    expect(refreshed.maxContextTokens).toBe(32768);
    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: refreshTarget.id,
      localPath: refreshTarget.localPath,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      accessState: ModelAccessState.AUTHORIZED,
      maxContextTokens: 32768,
      hasVerifiedContextWindow: true,
    }));
    expect((global.fetch as jest.Mock).mock.calls.some(([input]) => (
      String(input).includes('/api/models/org/stale-gated-context-model')
    ))).toBe(true);

    service.dispose();
  });

  it('does not refetch detail metadata after a short context ceiling has already been verified', async () => {
    const service = new ModelCatalogService();
    const refreshTarget: ModelMetadata = {
      id: 'org/verified-short-context-model',
      name: 'verified-short-context-model',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/verified-short-context-model/resolve/main/model.gguf',
      resolvedFileName: 'model.gguf',
      localPath: 'verified-short-context-model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    };
    global.fetch = jest.fn(() => {
      throw new Error('detail endpoint should not be requested for a verified short-context model');
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(refreshTarget);

    expect(refreshed.maxContextTokens).toBe(8192);
    expect(global.fetch).not.toHaveBeenCalled();

    service.dispose();
  });

  it('dedupes concurrent tree probes for the same repo and revision', async () => {
    const service = new ModelCatalogService();
    const treeResponse = createDeferred<any>();
    const refreshTarget: ModelMetadata = {
      id: 'org/tree-dedupe-model',
      name: 'tree-dedupe-model',
      author: 'org',
      size: null,
      downloadUrl: 'https://huggingface.co/org/tree-dedupe-model/resolve/deadbeef/model.gguf',
      hfRevision: 'deadbeef',
      resolvedFileName: 'model.gguf',
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: true,
      hasVerifiedContextWindow: true,
    };

    global.fetch = jest.fn(() => treeResponse.promise) as jest.Mock;

    const pendingLeft = service.refreshModelMetadata(refreshTarget);
    const pendingRight = service.refreshModelMetadata(refreshTarget);
    treeResponse.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        { path: 'model.gguf', size: 2 * 1024 * 1024 * 1024 },
      ]),
      headers: {
        get: jest.fn(() => null),
      },
    });

    const [left, right] = await Promise.all([pendingLeft, pendingRight]);

    expect(left.size).toBe(2 * 1024 * 1024 * 1024);
    expect(right.size).toBe(2 * 1024 * 1024 * 1024);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('replaces an aborted shared tree probe before its loader settles', async () => {
    const service = new ModelCatalogService();
    const firstTreeResponse = createDeferred<Response>();
    const firstController = new AbortController();
    const replacementController = new AbortController();
    const refreshTarget: ModelMetadata = {
      id: 'org/tree-abort-replacement',
      name: 'tree-abort-replacement',
      author: 'org',
      size: null,
      downloadUrl: 'https://huggingface.co/org/tree-abort-replacement/resolve/main/model.gguf',
      resolvedFileName: 'model.gguf',
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: true,
      hasVerifiedContextWindow: true,
    };
    let treeRequestCount = 0;
    global.fetch = jest.fn(() => {
      treeRequestCount += 1;
      if (treeRequestCount === 1) {
        return firstTreeResponse.promise;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([{
          path: 'model.gguf',
          size: 2 * 1024 * 1024 * 1024,
        }]),
      });
    }) as jest.Mock;

    const firstPending = service.refreshModelMetadata(refreshTarget, {
      signal: firstController.signal,
    });
    const handledFirst = firstPending.catch(() => undefined);
    await waitForMockCallCount(global.fetch as jest.Mock, 1);
    firstController.abort();

    const replacement = await service.refreshModelMetadata(refreshTarget, {
      signal: replacementController.signal,
    });

    expect(treeRequestCount).toBe(2);
    expect(replacement.size).toBe(2 * 1024 * 1024 * 1024);
    firstTreeResponse.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([{
        path: 'model.gguf',
        size: 1 * 1024 * 1024 * 1024,
      }]),
    } as unknown as Response);
    await handledFirst;
    await waitForCatalogRequestMapsToSettle(service);
    service.dispose();
  });

  it('preserves an explicit selected variant while refreshing tree-probed metadata', async () => {
    const service = new ModelCatalogService();
    const refreshTarget: ModelMetadata = {
      id: 'org/selected-tree-model',
      name: 'selected-tree-model',
      author: 'org',
      size: null,
      downloadUrl: 'https://huggingface.co/org/selected-tree-model/resolve/main/exact.Q8_0.gguf',
      resolvedFileName: 'exact.Q8_0.gguf',
      activeVariantId: 'exact.Q8_0.gguf',
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: true,
      hasVerifiedContextWindow: true,
      variants: [
        {
          variantId: 'earlier.Q4_K_M.gguf',
          fileName: 'earlier.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 3 * 1024 * 1024 * 1024,
        },
        {
          variantId: 'exact.Q8_0.gguf',
          fileName: 'exact.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: null,
        },
      ],
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('cursor=tree-page-2')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models/org/selected-tree-model/tree/main?recursive=true&cursor=tree-page-3>; rel="next"'
                : null
            )),
          },
          json: () => Promise.resolve([
            { path: 'exact.Q8_0.gguf', size: 8 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      if (url.includes('cursor=tree-page-3')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            { path: 'later.Q5_K_M.gguf', size: 4 * 1024 * 1024 * 1024 },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models/org/selected-tree-model/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
              : null
          )),
        },
        json: () => Promise.resolve([
          { path: 'earlier.Q4_K_M.gguf', size: 3 * 1024 * 1024 * 1024 },
        ]),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(refreshTarget, { includeDetails: false });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(refreshed).toEqual(expect.objectContaining({
      resolvedFileName: 'exact.Q8_0.gguf',
      activeVariantId: 'exact.Q8_0.gguf',
      size: 8 * 1024 * 1024 * 1024,
      requiresTreeProbe: true,
    }));
    expect(refreshed.variants?.map((variant) => variant.fileName)).toEqual(expect.arrayContaining([
      'earlier.Q4_K_M.gguf',
      'exact.Q8_0.gguf',
    ]));
    expect(refreshed.variants).toHaveLength(2);

    service.dispose();
  });

  it('dedupes concurrent lightweight auth probes for the same gated file', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    const service = new ModelCatalogService();
    const headResponse = createDeferred<any>();
    const refreshTarget: ModelMetadata = {
      id: 'org/probe-dedupe-model',
      name: 'probe-dedupe-model',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/probe-dedupe-model/resolve/deadbeef/model.gguf',
      hfRevision: 'deadbeef',
      resolvedFileName: 'model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    };

    global.fetch = jest.fn(() => headResponse.promise) as jest.Mock;

    const pendingLeft = service.refreshModelMetadata(refreshTarget);
    const pendingRight = service.refreshModelMetadata(refreshTarget);
    headResponse.resolve({
      ok: true,
      status: 200,
    });

    const [left, right] = await Promise.all([pendingLeft, pendingRight]);

    expect(left.accessState).toBe(ModelAccessState.AUTHORIZED);
    expect(right.accessState).toBe(ModelAccessState.AUTHORIZED);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('does not repopulate probe state when manual clear follows a resolved fetch', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    const service = new ModelCatalogService();
    const headResponse = createDeferred<Response>();
    const refreshTarget: ModelMetadata = {
      id: 'org/probe-clear-race',
      name: 'probe-clear-race',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/probe-clear-race/resolve/main/model.gguf',
      resolvedFileName: 'model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.AUTH_REQUIRED,
      isGated: true,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    };
    global.fetch = jest.fn(() => headResponse.promise) as jest.Mock;

    const pendingRefresh = service.refreshModelMetadata(refreshTarget);
    await waitForMockCallCount(global.fetch as jest.Mock, 1);
    headResponse.resolve({
      ok: true,
      status: 200,
    } as Response);
    service.clearCache('manual');

    await expect(pendingRefresh).rejects.toMatchObject({ code: 'cancelled' });
    expect((service as unknown as {
      resolvedFileProbeStateCache: Map<string, unknown>;
    }).resolvedFileProbeStateCache.size).toBe(0);
    await waitForCatalogRequestMapsToSettle(service);
    service.dispose();
  });

  it('revalidates authorized gated access probes across later metadata refreshes', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    const service = new ModelCatalogService();
    let headCallCount = 0;

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        headCallCount += 1;
        if (headCallCount > 1) {
          return Promise.resolve({
            ok: false,
            status: 404,
          });
        }

        return Promise.resolve({
          ok: true,
          status: 200,
        });
      }

      return Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          {
            id: 'org/probe-cache-model',
            gated: 'manual',
            siblings: [
              {
                rfilename: 'model.Q4_K_M.gguf',
                size: 2 * 1024 * 1024 * 1024,
              },
            ],
          },
        ]),
      });
    }) as jest.Mock;

    const initialResult = await service.searchModels('phi');
    expect(initialResult.models[0].accessState).toBe(ModelAccessState.AUTHORIZED);

    const refreshed = await service.refreshModelMetadata({
      ...initialResult.models[0],
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    });

    expect(refreshed.accessState).toBe(ModelAccessState.ACCESS_DENIED);
    expect(headCallCount).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(3);

    service.dispose();
  });

  it('dedupes concurrent README fetches for the same detailed model revision', async () => {
    const service = new ModelCatalogService();
    const readmeResponse = createDeferred<any>();
    let readmeCallCount = 0;

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/raw/main/README.md')) {
        readmeCallCount += 1;
        return readmeResponse.promise;
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeRepo('org/readme-dedupe-model')),
      });
    }) as jest.Mock;

    const pendingLeft = service.getModelDetails('org/readme-dedupe-model');
    const pendingRight = service.getModelDetails('org/readme-dedupe-model');
    readmeResponse.resolve({
      ok: true,
      text: () => Promise.resolve('# Model\n\nShared README summary for both requests.'),
    });

    const [left, right] = await Promise.all([pendingLeft, pendingRight]);

    expect(left.description).toBe('Shared README summary for both requests.');
    expect(right.description).toBe('Shared README summary for both requests.');
    expect(readmeCallCount).toBe(1);

    service.dispose();
  });

  it('evicts buffered pages before ordinary and reusable first-page cache entries', () => {
    const service = new ModelCatalogService();
    type SearchEntry = {
      result: { models: ModelMetadata[]; hasMore: boolean; nextCursor: string | null };
      timestamp: number;
      isBufferedCursor: boolean;
      isReusableFirstPage: boolean;
      lastAccessSequence: number;
      deferredMetadataPending?: boolean;
    };
    const internals = service as unknown as {
      searchCache: Map<string, SearchEntry>;
      pruneSearchCache(): void;
    };
    const now = Date.now();
    const put = (key: string, entry: Omit<SearchEntry, 'result' | 'timestamp'>) => {
      internals.searchCache.set(key, {
        result: { models: [], hasMore: false, nextCursor: null },
        timestamp: now,
        ...entry,
      });
    };

    for (let index = 0; index < 118; index += 1) {
      put(`first-${index}`, {
        isBufferedCursor: false,
        isReusableFirstPage: true,
        lastAccessSequence: 100 + index,
      });
    }
    put('ordinary-deferred', {
      isBufferedCursor: false,
      isReusableFirstPage: false,
      lastAccessSequence: 1,
      deferredMetadataPending: true,
    });
    put('buffer-old', {
      isBufferedCursor: true,
      isReusableFirstPage: false,
      lastAccessSequence: 2,
    });
    put('buffer-middle', {
      isBufferedCursor: true,
      isReusableFirstPage: false,
      lastAccessSequence: 3,
    });
    put('buffer-new', {
      isBufferedCursor: true,
      isReusableFirstPage: false,
      lastAccessSequence: 4,
    });

    internals.pruneSearchCache();

    expect(internals.searchCache.size).toBe(120);
    expect(internals.searchCache.has('buffer-old')).toBe(false);
    expect(internals.searchCache.has('buffer-middle')).toBe(false);
    expect(internals.searchCache.has('buffer-new')).toBe(true);
    expect(internals.searchCache.has('ordinary-deferred')).toBe(true);
    expect(internals.searchCache.has('first-0')).toBe(true);
    service.dispose();
  });

  it('keeps a real-search overflow cursor usable while the cache remains bounded', async () => {
    const service = new ModelCatalogService();
    type SearchEntry = {
      result: { models: ModelMetadata[]; hasMore: boolean; nextCursor: string | null };
      timestamp: number;
      isBufferedCursor: boolean;
      isReusableFirstPage: boolean;
      lastAccessSequence: number;
    };
    const searchCache = (service as unknown as {
      searchCache: Map<string, SearchEntry>;
    }).searchCache;
    const now = Date.now();
    for (let index = 0; index < 120; index += 1) {
      searchCache.set(`anon::0::seed-${index}`, {
        result: { models: [], hasMore: false, nextCursor: null },
        timestamp: now,
        isBufferedCursor: false,
        isReusableFirstPage: true,
        lastAccessSequence: index + 1,
      });
    }
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      json: () => Promise.resolve([
        makeRepo('org/overflow-page-one'),
        makeRepo('org/overflow-page-two'),
      ]),
    })) as jest.Mock;

    const firstPage = await service.searchModels('overflow-real', { pageSize: 1 });

    expect(firstPage.models.map((model) => model.id)).toEqual(['org/overflow-page-one']);
    expect(firstPage.nextCursor).toMatch(/^catalog-buffer:/);
    expect(searchCache.size).toBe(120);

    await huggingFaceTokenService.saveToken('hf_added_after_anonymous_page');

    const secondPage = await service.searchModels('overflow-real', {
      pageSize: 1,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.models.map((model) => model.id)).toEqual(['org/overflow-page-two']);
    expect(secondPage.nextCursor).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(searchCache.size).toBeLessThanOrEqual(120);
    service.dispose();
  });

  it('uses explicit access recency when ordinary pages compete for overflow eviction', () => {
    const service = new ModelCatalogService();
    type SearchEntry = {
      result: { models: ModelMetadata[]; hasMore: boolean; nextCursor: string | null };
      timestamp: number;
      isBufferedCursor: boolean;
      isReusableFirstPage: boolean;
      lastAccessSequence: number;
    };
    const internals = service as unknown as {
      searchCache: Map<string, SearchEntry>;
      searchCacheAccessSequence: number;
      pruneSearchCache(): void;
      touchSearchCacheEntry(key: string): void;
    };
    const now = Date.now();
    const result = { models: [], hasMore: false, nextCursor: null };

    for (let index = 0; index < 119; index += 1) {
      internals.searchCache.set(`first-${index}`, {
        result,
        timestamp: now,
        isBufferedCursor: false,
        isReusableFirstPage: true,
        lastAccessSequence: 100 + index,
      });
    }
    internals.searchCache.set('ordinary-touched', {
      result,
      timestamp: now,
      isBufferedCursor: false,
      isReusableFirstPage: false,
      lastAccessSequence: 1,
    });
    internals.searchCache.set('ordinary-idle', {
      result,
      timestamp: now,
      isBufferedCursor: false,
      isReusableFirstPage: false,
      lastAccessSequence: 2,
    });
    internals.searchCacheAccessSequence = 220;
    internals.touchSearchCacheEntry('ordinary-touched');

    internals.pruneSearchCache();

    expect(internals.searchCache.size).toBe(120);
    expect(internals.searchCache.has('ordinary-touched')).toBe(true);
    expect(internals.searchCache.has('ordinary-idle')).toBe(false);
    expect(internals.searchCache.has('first-0')).toBe(true);
    service.dispose();
  });

  it('removes expired entries before overflow and uses LRU only as the first-page last resort', () => {
    const service = new ModelCatalogService();
    type SearchEntry = {
      result: { models: ModelMetadata[]; hasMore: boolean; nextCursor: string | null };
      timestamp: number;
      isBufferedCursor: boolean;
      isReusableFirstPage: boolean;
      lastAccessSequence: number;
    };
    const internals = service as unknown as {
      searchCache: Map<string, SearchEntry>;
      pruneSearchCache(): void;
    };
    const result = { models: [], hasMore: false, nextCursor: null };
    const now = Date.now();

    internals.searchCache.set('expired-first', {
      result,
      timestamp: now - (6 * 60 * 1000),
      isBufferedCursor: false,
      isReusableFirstPage: true,
      lastAccessSequence: 999,
    });
    for (let index = 0; index < 120; index += 1) {
      internals.searchCache.set(`fresh-first-${index}`, {
        result,
        timestamp: now,
        isBufferedCursor: false,
        isReusableFirstPage: true,
        lastAccessSequence: index + 1,
      });
    }

    internals.pruneSearchCache();
    expect(internals.searchCache.size).toBe(120);
    expect(internals.searchCache.has('expired-first')).toBe(false);
    expect(internals.searchCache.has('fresh-first-0')).toBe(true);

    internals.searchCache.set('fresh-first-new', {
      result,
      timestamp: now,
      isBufferedCursor: false,
      isReusableFirstPage: true,
      lastAccessSequence: 121,
    });
    internals.pruneSearchCache();

    expect(internals.searchCache.size).toBe(120);
    expect(internals.searchCache.has('fresh-first-0')).toBe(false);
    expect(internals.searchCache.has('fresh-first-new')).toBe(true);
    service.dispose();
  });

  it('throws model detail errors instead of returning a fabricated fallback model', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
      }),
    ) as jest.Mock;

    await expect(modelCatalogService.getModelDetails('org/missing-model')).rejects.toMatchObject({
      code: 'network',
    });
  });
});
