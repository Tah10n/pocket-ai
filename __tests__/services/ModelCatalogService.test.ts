import DeviceInfo from 'react-native-device-info';
import {
  ModelCatalogError,
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

function makeGatedRepo(id: string, filename = 'model.Q4_K_M.gguf') {
  return {
    ...makeRepoWithUnknownSize(id, filename),
    gated: 'manual',
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

      if (url.includes('limit=30')) {
        const repos = Array.from({ length: 30 }, (_, index) =>
          index < 10
            ? makeRepo(`org/model-${index}`)
            : makeRepo(`org/not-gguf-${index}`, 1024, 'README.md'),
        );

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
                ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-3>; rel="next", <https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-1>; rel="prev"'
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
              ? '<https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-2>; rel="next", <https://huggingface.co/api/models?search=phi%20gguf&limit=30&cursor=page-0>; rel="prev"'
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
});
