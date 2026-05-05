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
    sha256: 'stale-projector-sha',
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
      sha256: 'real-model-sha',
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
      sha256: 'real-main-model-sha',
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
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/verified-local-context-model'),
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
            ...makeRepo(localModel.id),
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

  it('preserves authenticated persisted catalog cache during startup token hydration', async () => {
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

    expect(offlineResult.models[0].id).toBe('org/auth-persisted-model');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses the resolved token presence for cached fallback lookups before token hydration finishes', async () => {
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

    expect(fallbackResult.models[0].id).toBe('org/auth-fallback-model');
    expect(fallbackResult.warning?.code).toBe('rate_limited');
  });

  it('retries the first-page search when the auth token changes mid-flight and keeps only the fresh cache entry', async () => {
    await huggingFaceTokenService.saveToken('hf_token_a');
    const firstPage = createDeferred<any>();
    const service = new ModelCatalogService();

    global.fetch = (
      jest.fn()
        .mockImplementationOnce(() => firstPage.promise)
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
    expect(cachedResult?.models[0].id).toBe('org/auth-new-model');
    expect(global.fetch).toHaveBeenCalledTimes(2);

    coldStartService.dispose();
    service.dispose();
  });

  it('throws load-more errors for later pages instead of silently falling back', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
      }),
    ) as jest.Mock;

    await expect(modelCatalogService.searchModels('phi', {
      cursor: 'https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-2',
      pageSize: 10,
    })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('disables cached pagination offline and rejects offline cursor fetches', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-2>; rel="next"'
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
      cursor: 'https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-2',
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
              lfs: { sha256: 'tree-sha' },
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
    expect(result.models[0].sha256).toBe('tree-sha');
    expect(result.models[0].requiresTreeProbe).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/tree/main?recursive=true');
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

  it('prefers remote sizes over unverified local sizes when merging catalog results with the registry', async () => {
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
        json: () => Promise.resolve([makeRepo(localModel.id, 3 * 1024 * 1024 * 1024)]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe(localModel.id);
    expect(result.models[0].localPath).toBe(localModel.localPath);
    expect(result.models[0].lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    expect(result.models[0].size).toBe(3 * 1024 * 1024 * 1024);
  });

  it('prefers verified local sizes over remote sizes when merging catalog results with the registry', async () => {
    const localModel: ModelMetadata = {
      ...makeLocalModel('org/verified-local-size-model'),
      accessState: ModelAccessState.PUBLIC,
      size: 4 * 1024 * 1024 * 1024,
      metadataTrust: 'verified_local',
      gguf: { totalBytes: 4 * 1024 * 1024 * 1024 },
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
        json: () => Promise.resolve([makeRepo(localModel.id, 3 * 1024 * 1024 * 1024)]),
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
              lfs: { sha256: 'partial-tree-q8-sha' },
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
    expect(result.models[0].sha256).toBe('partial-tree-q8-sha');
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('cursor=tree-page-2');
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
              lfs: { sha256: 'paged-tree-sha' },
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
    expect(result.models[0].sha256).toBe('paged-tree-sha');
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

      if (url.includes('limit=30')) {
        const repos = Array.from({ length: 10 }, (_, index) => makeRepo(`org/model-${index}`));

        return Promise.resolve({
          ok: true,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-2>; rel="next"'
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
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-2>; rel="next"'
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
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('limit=30');
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
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-2>; rel="next"'
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

    expect(cachedModel).not.toBeNull();
    expect(cachedModel?.accessState).toBe(ModelAccessState.AUTH_REQUIRED);
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
          ...makeRepo('org/stale-context-model', 2 * 1024 * 1024 * 1024),
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
            ...makeRepo('org/stale-gated-context-model', 2 * 1024 * 1024 * 1024),
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

  it('reuses recent gated access probe results across later metadata refreshes', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');
    const service = new ModelCatalogService();

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
    await service.refreshModelMetadata({
      ...initialResult.models[0],
      maxContextTokens: 8192,
      hasVerifiedContextWindow: true,
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);

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
