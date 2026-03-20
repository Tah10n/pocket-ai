import DeviceInfo from 'react-native-device-info';
import {
  ModelCatalogError,
  modelCatalogService,
} from '../../src/services/ModelCatalogService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { LifecycleStatus, type ModelMetadata } from '../../src/types/models';

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

function makeLocalModel(id: string): ModelMetadata {
  return {
    id,
    name: id.split('/').pop() ?? id,
    author: id.split('/')[0] ?? 'local',
    size: 1024,
    downloadUrl: `https://example.com/${id}.gguf`,
    localPath: `${id.replace('/', '_')}.gguf`,
    fitsInRam: true,
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1,
  };
}

describe('ModelCatalogService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (modelCatalogService as any).searchCache.clear();
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

    await expect(modelCatalogService.searchModels('phi', { page: 1, pageSize: 10 })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('sets hasMore false when a full raw page still cannot prove another filtered result exists', async () => {
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

    const result = await modelCatalogService.searchModels('phi', { page: 0, pageSize: 10 });

    expect(result.models).toHaveLength(3);
    expect(result.hasMore).toBe(false);
  });

  it('keeps GGUF entries even when the list response omits file size metadata', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === 'string' && init?.method === 'HEAD') {
        return Promise.resolve({
          headers: {
            get: jest.fn().mockReturnValue(String(2 * 1024 * 1024 * 1024)),
          },
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
  });

  it('keeps loading more source repos until it can prove there is another filtered page', async () => {
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
          json: () => Promise.resolve(repos),
        });
      }

      if (url.includes('limit=60')) {
        const repos = Array.from({ length: 60 }, (_, index) =>
          index < 11
            ? makeRepo(`org/model-${index}`)
            : makeRepo(`org/not-gguf-${index}`, 1024, 'README.md'),
        );

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(repos),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi', { page: 0, pageSize: 10 });

    expect(result.models).toHaveLength(10);
    expect(result.hasMore).toBe(true);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('sets hasMore false when the API returns fewer repos than requested', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeRepo('org/model-1'), makeRepo('org/model-2')]),
      }),
    ) as jest.Mock;

    const result = await modelCatalogService.searchModels('phi', { page: 0, pageSize: 10 });

    expect(result.models).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });
});
