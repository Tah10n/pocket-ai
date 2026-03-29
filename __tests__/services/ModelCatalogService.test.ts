import DeviceInfo from 'react-native-device-info';
import * as SecureStore from 'expo-secure-store';
import {
  ModelCatalogError,
  ModelCatalogService,
  modelCatalogService,
} from '../../src/services/ModelCatalogService';
import { huggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

jest.mock('../../src/services/HardwareListenerService', () => ({
  hardwareListenerService: {
    getCurrentStatus: jest.fn().mockReturnValue({ isConnected: true }),
  },
}));

jest.mock('../../src/services/LocalStorageRegistry', () => ({
  registry: {
    getModels: jest.fn(),
    getModel: jest.fn(),
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

const mockedRegistry = registry as jest.Mocked<typeof registry>;

function makeRepo(
  id: string,
  size = 1.5 * 1024 * 1024 * 1024,
  filename = 'model.Q4_K_M.gguf',
) {
  return {
    id,
    sha: 'deadbeef',
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
    sha: 'deadbeef',
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
    sha: 'deadbeef',
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
    sha: 'deadbeef',
    tags: ['gguf', 'chat'],
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

describe('ModelCatalogService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    (modelCatalogService as any).searchCache.clear();
    (modelCatalogService as any).modelSnapshotCache.clear();
    (modelCatalogService as any).persistentCache.clearAll();
    await huggingFaceTokenService.clearToken();
    mockedRegistry.getModels.mockReturnValue([]);
    mockedRegistry.getModel.mockReturnValue(undefined);
    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: true });
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    (DeviceInfo.getFreeDiskStorage as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024);
  });

  it('filters models based on hardware constraints', async () => {
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * 1024 * 1024 * 1024);

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/small-model')]),
      }),
    ) as jest.Mock;

    const available = await modelCatalogService.searchModels();

    expect(available.models).toHaveLength(1);
    expect(available.models[0].id).toBe('org/small-model');
    expect(available.models[0].fitsInRam).toBe(true);
    expect(available.hasMore).toBe(false);
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

    expect(result.models).toEqual([localModel]);
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

  it('throws load-more errors for later pages instead of silently falling back', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
      }),
    ) as jest.Mock;

    await expect(modelCatalogService.searchModels('phi', {
      cursor: 'https://huggingface.co/api/models?search=phi%20gguf&limit=10&cursor=page-2',
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
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=10&cursor=page-2>; rel="next"'
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
      cursor: 'https://huggingface.co/api/models?search=phi%20gguf&limit=10&cursor=page-2',
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
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/unknown-size-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/unknown-size-model');
    expect(result.models[0].size).toBe(2 * 1024 * 1024 * 1024);
    expect(result.models[0].sha256).toBe('tree-sha');
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
        json: () => Promise.resolve([makeIncompletePublicRepo('org/public-probe-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/public-probe-model');
    expect(result.models[0].accessState).toBe(ModelAccessState.PUBLIC);
    expect(result.models[0].size).toBe(2 * 1024 * 1024 * 1024);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/tree/main?recursive=true');
  });

  it('keeps nullable size when both list and tree metadata omit the file size', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (typeof input === 'string' && input.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            {
              path: 'model.Q4_K_M.gguf',
            },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/still-unknown-size-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].size).toBeNull();
    expect(result.models[0].fitsInRam).toBeNull();
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
    expect(result.models[0].downloadUrl).toContain('model.Q4_K_M.gguf');
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
        json: () => Promise.resolve([makeRepoWithUnknownSize('org/paged-tree-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].size).toBe(3 * 1024 * 1024 * 1024);
    expect(result.models[0].sha256).toBe('paged-tree-sha');
    expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('cursor=tree-page-2');
  });

  it('marks gated models as auth_required when no token is configured', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeGatedRepo('org/gated-model')]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

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
        json: () => Promise.resolve([makeGatedRepo('org/denied-model')]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0].accessState).toBe(ModelAccessState.ACCESS_DENIED);
  });

  it('revalidates size-known gated models with the tree endpoint before marking them authorized', async () => {
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
        json: () => Promise.resolve([
          {
            ...makeRepo('org/size-known-gated-model'),
            gated: 'manual',
          },
        ]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi');

    expect(result.models[0].accessState).toBe(ModelAccessState.ACCESS_DENIED);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/tree/main?recursive=true');
  });

  it('derives hasMore from the next cursor header without extra page-proving fetches', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('limit=10')) {
        const repos = Array.from({ length: 10 }, (_, index) => makeRepo(`org/model-${index}`));

        return Promise.resolve({
          ok: true,
          headers: {
            get: jest.fn((headerName: string) => (
              headerName === 'link'
                ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=10&cursor=page-2>; rel="next"'
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
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=10&cursor=page-2>; rel="next"'
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
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('limit=10');
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
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=10&cursor=page-2>; rel="next"'
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
    expect(result.models[0].tags).toEqual(['gguf', 'chat']);
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
          cardData: {
            base_model: ['meta-llama/Llama-3.1-8B-Instruct'],
            language: ['en', 'de'],
            quantized_by: 'bartowski',
            model_type: 'llama',
          },
          config: {
            architectures: ['LlamaForCausalLM'],
          },
        }),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.getModelDetails('org/rich-detail-model');

    expect(result.modelType).toBe('llama');
    expect(result.architectures).toEqual(['LlamaForCausalLM']);
    expect(result.baseModels).toEqual(['meta-llama/Llama-3.1-8B-Instruct']);
    expect(result.license).toBe('apache-2.0');
    expect(result.languages).toEqual(['en', 'de']);
    expect(result.datasets).toEqual(['ultrachat_200k']);
    expect(result.quantizedBy).toBe('bartowski');
    expect(result.modelCreator).toBe('Meta');
  });

  it('keeps gated model details locked when tree validation fails after the details payload succeeds', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

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

    expect(result.accessState).toBe(ModelAccessState.AUTH_REQUIRED);
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
