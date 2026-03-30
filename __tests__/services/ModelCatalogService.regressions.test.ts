import DeviceInfo from 'react-native-device-info';
import { ModelCatalogService } from '../../src/services/ModelCatalogService';
import { huggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { ModelAccessState } from '../../src/types/models';

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

function makeIncompleteGatedRepo(id: string) {
  return {
    id,
    gated: 'manual',
    tags: ['gguf', 'chat'],
    downloads: 42,
  };
}

function makeSignalLessIncompleteGatedRepo(id: string) {
  return {
    id,
    gated: 'manual',
    downloads: 42,
  };
}

function makeSizedGatedRepo(id: string) {
  return {
    id,
    gated: 'manual',
    siblings: [
      {
        rfilename: 'model.Q4_K_M.gguf',
        size: 2 * 1024 * 1024 * 1024,
      },
    ],
  };
}

function makeTextGenerationRepo(id: string) {
  return {
    id,
    pipeline_tag: 'text-generation',
    tags: ['gguf', 'chat'],
    siblings: [
      {
        rfilename: 'model.Q4_K_M.gguf',
        size: 2 * 1024 * 1024 * 1024,
      },
    ],
  };
}

function makeImageGenerationRepo(id: string) {
  return {
    id,
    pipeline_tag: 'text-to-image',
    tags: ['gguf', 'diffusers', 'flux'],
    siblings: [
      {
        rfilename: 'model.Q4_K_M.gguf',
        size: 2 * 1024 * 1024 * 1024,
      },
    ],
  };
}

function makePipelineLessImageRepo(id: string) {
  return {
    id,
    tags: ['gguf', 'diffusers', 'stable-diffusion'],
    siblings: [
      {
        rfilename: 'model.Q4_K_M.gguf',
        size: 2 * 1024 * 1024 * 1024,
      },
    ],
  };
}

describe('ModelCatalogService regressions', () => {
  let service: ModelCatalogService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedRegistry.getModels.mockReturnValue([]);
    mockedRegistry.getModel.mockReturnValue(undefined);
    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: true });
    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
    await huggingFaceTokenService.clearToken();
    service = new ModelCatalogService();
  });

  afterEach(() => {
    service.dispose();
  });

  it('keeps gated GGUF repos visible when the list response omits siblings and tree auth is required', async () => {
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
        json: () => Promise.resolve([makeIncompleteGatedRepo('org/locked-GGUF')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/locked-GGUF');
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTH_REQUIRED);
  });

  it('drops GGUF repos that Hugging Face marks as image-generation pipelines', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          makeImageGenerationRepo('org/flux-image-model'),
          makeTextGenerationRepo('org/chat-model'),
        ]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/chat-model');
  });

  it('drops GGUF repos with diffusion/image tags even when pipeline metadata is missing', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          makePipelineLessImageRepo('org/tag-only-image-model'),
          makeTextGenerationRepo('org/chat-model'),
        ]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/chat-model');
  });

  it('drops gated repos when the list payload omits both siblings and gguf catalog hints', async () => {
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
        json: () => Promise.resolve([makeSignalLessIncompleteGatedRepo('org/locked-model')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(0);
  });

  it('does not upgrade auth-required probe candidates to authorized on non-auth tree failures', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve([]),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeIncompleteGatedRepo('org/rate-limited-gguf')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTH_REQUIRED);
  });

  it('drops probe candidates when tree access succeeds but no GGUF file exists', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([
            { path: 'README.md', size: 1024 },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeIncompleteGatedRepo('org/not-really-gguf')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(0);
  });

  it('keeps probe candidates visible when a later tree page fails after partial success', async () => {
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
                ? '<https://huggingface.co/api/models/org/paged-probe/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
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
        json: () => Promise.resolve([makeIncompleteGatedRepo('org/paged-probe')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe('org/paged-probe');
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTH_REQUIRED);
    expect(result.models[0].requiresTreeProbe).toBe(true);
  });

  it('keeps size-known gated repos locked when the lightweight access probe fails with a non-auth error', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: false,
          status: 429,
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeSizedGatedRepo('org/size-known-but-unvalidated')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTH_REQUIRED);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/resolve/main/model.Q4_K_M.gguf');
  });

  it('falls back to tree validation when the lightweight access probe is unsupported', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: false,
          status: 405,
        });
      }

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
                ? '<https://huggingface.co/api/models/org/partially-paged-sized-gated/tree/main?recursive=true&cursor=tree-page-2>; rel="next"'
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
        json: () => Promise.resolve([makeSizedGatedRepo('org/partially-paged-sized-gated')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTH_REQUIRED);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/resolve/main/model.Q4_K_M.gguf');
    expect((global.fetch as jest.Mock).mock.calls[2][1]).toMatchObject({ method: 'GET' });
    expect((global.fetch as jest.Mock).mock.calls[3][0]).toContain('/tree/main?recursive=true');
  });
});
