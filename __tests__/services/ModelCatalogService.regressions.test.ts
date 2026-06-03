import DeviceInfo from 'react-native-device-info';
import { ModelCatalogService } from '../../src/services/ModelCatalogService';
import { huggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { MultimodalReadinessState, ProjectorArtifact } from '../../src/types/multimodal';
import { buildProjectorArtifactId } from '../../src/utils/modelProjectors';

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

const mockedRegistry = registry as jest.Mocked<typeof registry>;
const TREE_SHA256 = 'a'.repeat(64);
const PARTIAL_TREE_SHA256 = 'b'.repeat(64);
const PROJECTOR_SHA256 = 'c'.repeat(64);
const DIFFERENT_PROJECTOR_SHA256 = 'd'.repeat(64);

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

function makeVisionRepo(
  id: string,
  modelFileName: string,
  projectorFileName: string,
  projectorMetadata: { size?: number; sha256?: string } = {},
) {
  return {
    id,
    pipeline_tag: 'text-generation',
    tags: ['gguf', 'chat', 'vision'],
    siblings: [
      {
        rfilename: modelFileName,
        size: 2 * 1024 * 1024 * 1024,
      },
      {
        rfilename: projectorFileName,
        size: projectorMetadata.size ?? 1024,
        ...(projectorMetadata.sha256 ? { lfs: { sha256: projectorMetadata.sha256 } } : {}),
      },
    ],
  };
}

function makeDownloadedVisionModelWithProjector(options: {
  modelId: string;
  modelFileName?: string;
  projectorFileName?: string;
  projectorSize?: number;
  projectorSha256?: string;
  projectorDownloadUrl?: string;
}): {
  localModel: ModelMetadata;
  localProjector: ProjectorArtifact;
  modelFileName: string;
  projectorFileName: string;
} {
  const modelFileName = options.modelFileName ?? 'model.Q4_K_M.gguf';
  const projectorFileName = options.projectorFileName ?? 'mmproj-model-f16.gguf';
  const projectorId = buildProjectorArtifactId({
    repoId: options.modelId,
    hfRevision: 'main',
    fileName: projectorFileName,
  });
  const projectorDownloadUrl = options.projectorDownloadUrl
    ?? `https://huggingface.co/${options.modelId}/resolve/main/${projectorFileName}`;
  const localProjector: ProjectorArtifact = {
    id: projectorId,
    ownerModelId: options.modelId,
    repoId: options.modelId,
    fileName: projectorFileName,
    downloadUrl: projectorDownloadUrl,
    hfRevision: 'main',
    ...(options.projectorSha256 ? { sha256: options.projectorSha256 } : {}),
    size: options.projectorSize ?? 1024,
    localPath: `local-${projectorFileName}`,
    lifecycleStatus: 'downloaded',
    matchStatus: 'matched',
  };
  const localModel: ModelMetadata = {
    id: options.modelId,
    name: 'Downloaded Vision Model',
    author: 'org',
    size: 2 * 1024 * 1024 * 1024,
    downloadUrl: `https://huggingface.co/${options.modelId}/resolve/main/${modelFileName}`,
    hfRevision: 'main',
    resolvedFileName: modelFileName,
    localPath: modelFileName,
    downloadedAt: 1234,
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1,
    chatModalities: ['text', 'vision'],
    projectorCandidates: [localProjector],
    selectedProjectorId: localProjector.id,
    multimodalReadiness: {
      modelId: options.modelId,
      variantId: modelFileName,
      status: 'ready',
      projectorId: localProjector.id,
      support: ['vision'],
      checkedAt: 1234,
    },
  };

  return { localModel, localProjector, modelFileName, projectorFileName };
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

  it('keeps gated GGUF repos visible when tree access is forbidden and size cannot be resolved', async () => {
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

  it('marks gated probe candidates authorized when a token is configured', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/tree/main?recursive=true')) {
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
        json: () => Promise.resolve([makeIncompleteGatedRepo('org/rate-limited-gguf')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTHORIZED);
    expect(result.models[0].size).toBe(2 * 1024 * 1024 * 1024);
    expect(result.models[0].sha256).toBe(TREE_SHA256);
    expect(result.models[0].requiresTreeProbe).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('drops probe candidates when tree validation completes without a GGUF entry', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
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
    expect(global.fetch).toHaveBeenCalledTimes(2);
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
            {
              path: 'model.Q4_K_M.gguf',
              size: 2 * 1024 * 1024 * 1024,
              lfs: { sha256: PARTIAL_TREE_SHA256 },
            },
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
    expect(result.models[0].size).toBe(2 * 1024 * 1024 * 1024);
    expect(result.models[0].sha256).toBe(PARTIAL_TREE_SHA256);
    expect(result.models[0].requiresTreeProbe).toBe(true);
  });

  it('keeps bounded vision refresh self-contained and defers later projector entries', async () => {
    const modelId = 'org/paged-vision-projector';
    const modelFileName = 'model.Q4_K_M.gguf';
    const projectorFileName = 'mmproj-model-f16.gguf';
    const treePage2Cursor = 'tree-page-2';
    const model: ModelMetadata = {
      id: modelId,
      name: 'Paged Vision Projector',
      author: 'org',
      size: null,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      chatModalities: ['text', 'vision'],
      requiresTreeProbe: true,
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes(`cursor=${treePage2Cursor}`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            {
              path: projectorFileName,
              size: 1024,
              lfs: { sha256: PROJECTOR_SHA256 },
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
                ? `<https://huggingface.co/api/models/${modelId}/tree/main?recursive=true&cursor=${treePage2Cursor}>; rel="next"`
                : null
            )),
          },
          json: () => Promise.resolve([
            {
              path: modelFileName,
              size: 2 * 1024 * 1024 * 1024,
              lfs: { sha256: TREE_SHA256 },
            },
          ]),
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(model, { includeDetails: false });

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining(`cursor=${treePage2Cursor}`),
      expect.any(Object),
    );
    expect(refreshed.projectorCandidates).toBeUndefined();
    expect(refreshed.chatModalities).toContain('vision');
  });

  it('uses the full projector-aware tree budget even when primary metadata is already known', async () => {
    const modelId = 'org/deep-paged-vision-projector';
    const modelFileName = 'model.Q4_K_M.gguf';
    const projectorFileName = 'mmproj-model-f16.gguf';
    const pageCount = 5;
    const model: ModelMetadata = {
      id: modelId,
      name: 'Deep Paged Vision Projector',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      chatModalities: ['text', 'vision'],
      requiresTreeProbe: false,
      hasVerifiedContextWindow: true,
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const cursorMatch = url.match(/cursor=tree-page-(\d+)/);
      const pageNumber = cursorMatch ? Number(cursorMatch[1]) : 1;
      const nextPageNumber = pageNumber + 1;

      if (!url.includes('/tree/main?recursive=true') || pageNumber < 1 || pageNumber > pageCount) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      const isLastPage = pageNumber === pageCount;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link' && !isLastPage
              ? `<https://huggingface.co/api/models/${modelId}/tree/main?recursive=true&cursor=tree-page-${nextPageNumber}>; rel="next"`
              : null
          )),
        },
        json: () => Promise.resolve(
          pageNumber === 1
            ? [{ path: modelFileName, size: model.size, lfs: { sha256: TREE_SHA256 } }]
            : pageNumber === pageCount
              ? [{ path: projectorFileName, size: 1024, lfs: { sha256: PROJECTOR_SHA256 } }]
              : [{ path: `README-page-${pageNumber}.md`, size: 1024 }],
        ),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(model, { includeDetails: true });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('cursor=tree-page-5'),
      expect.any(Object),
    );
    expect(refreshed.projectorCandidates).toHaveLength(1);
    expect(refreshed.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      fileName: projectorFileName,
      sha256: PROJECTOR_SHA256,
    }));
    expect(refreshed.requiresTreeProbe).toBe(false);
  });

  it('preserves stale projector state when bounded projector-aware probes hit the page cap', async () => {
    const modelId = 'org/bounded-stale-projector-preserve';
    const modelFileName = 'model.Q4_K_M.gguf';
    const {
      localModel,
      localProjector,
    } = makeDownloadedVisionModelWithProjector({
      modelId,
      modelFileName,
      projectorSha256: PROJECTOR_SHA256,
    });
    const refreshTarget = {
      ...localModel,
      sha256: TREE_SHA256,
      downloadIntegrity: {
        kind: 'sha256' as const,
        sha256: TREE_SHA256,
        sizeBytes: localModel.size ?? 0,
        checkedAt: 1234,
      },
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const cursorMatch = url.match(/cursor=tree-page-(\d+)/);
      const pageNumber = cursorMatch ? Number(cursorMatch[1]) : 1;
      const nextPageNumber = pageNumber + 1;

      if (!url.includes('/tree/main?recursive=true') || pageNumber < 1 || pageNumber > 4) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? `<https://huggingface.co/api/models/${modelId}/tree/main?recursive=true&cursor=tree-page-${nextPageNumber}>; rel="next"`
              : null
          )),
        },
        json: () => Promise.resolve([{ path: `README-page-${pageNumber}.md`, size: 1024 }]),
      });
    }) as jest.Mock;

    mockedRegistry.getModel.mockReturnValue(refreshTarget);

    const refreshed = await service.refreshModelMetadata(refreshTarget, { includeDetails: false });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('cursor=tree-page-4'),
      expect.any(Object),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('cursor=tree-page-5'),
      expect.any(Object),
    );
    expect(refreshed.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: localProjector.id,
      localPath: localProjector.localPath,
      lifecycleStatus: localProjector.lifecycleStatus,
    }));
    expect(refreshed.selectedProjectorId).toBe(localProjector.id);
    expect(refreshed.multimodalReadiness?.projectorId).toBe(localProjector.id);
    expect(refreshed.requiresTreeProbe).toBe(true);
  });

  it('preserves unmatched local projector state when incomplete probes discover partial remote candidates', async () => {
    const modelId = 'org/bounded-partial-projector-preserve';
    const modelFileName = 'model.Q4_K_M.gguf';
    const localProjectorFileName = 'mmproj-local-f16.gguf';
    const remoteProjectorFileName = 'mmproj-remote-f16.gguf';
    const remoteProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      fileName: remoteProjectorFileName,
    });
    const {
      localModel,
      localProjector,
    } = makeDownloadedVisionModelWithProjector({
      modelId,
      modelFileName,
      projectorFileName: localProjectorFileName,
      projectorSha256: PROJECTOR_SHA256,
    });
    const refreshTarget = {
      ...localModel,
      sha256: TREE_SHA256,
      downloadIntegrity: {
        kind: 'sha256' as const,
        sha256: TREE_SHA256,
        sizeBytes: localModel.size ?? 0,
        checkedAt: 1234,
      },
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const cursorMatch = url.match(/cursor=tree-page-(\d+)/);
      const pageNumber = cursorMatch ? Number(cursorMatch[1]) : 1;
      const nextPageNumber = pageNumber + 1;

      if (!url.includes('/tree/main?recursive=true') || pageNumber < 1 || pageNumber > 4) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? `<https://huggingface.co/api/models/${modelId}/tree/main?recursive=true&cursor=tree-page-${nextPageNumber}>; rel="next"`
              : null
          )),
        },
        json: () => Promise.resolve(
          pageNumber === 4
            ? [{ path: modelFileName, size: localModel.size, lfs: { sha256: TREE_SHA256 } }]
            : pageNumber === 2
              ? [{ path: remoteProjectorFileName, size: 2048, lfs: { sha256: DIFFERENT_PROJECTOR_SHA256 } }]
              : [{ path: `README-page-${pageNumber}.md`, size: 1024 }],
        ),
      });
    }) as jest.Mock;
    mockedRegistry.getModel.mockReturnValue(refreshTarget);

    const refreshed = await service.refreshModelMetadata(refreshTarget, { includeDetails: false });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('cursor=tree-page-4'),
      expect.any(Object),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('cursor=tree-page-5'),
      expect.any(Object),
    );
    expect(refreshed.projectorCandidates).toHaveLength(2);
    expect(refreshed.projectorCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: remoteProjectorId,
        fileName: remoteProjectorFileName,
        sha256: DIFFERENT_PROJECTOR_SHA256,
      }),
      expect.objectContaining({
        id: localProjector.id,
        localPath: localProjector.localPath,
        lifecycleStatus: localProjector.lifecycleStatus,
      }),
    ]));
    expect(refreshed.selectedProjectorId).toBe(localProjector.id);
    expect(refreshed.multimodalReadiness?.projectorId).toBe(localProjector.id);
  });

  it('does not preserve unmatched local projector state for another active variant during incomplete probes', async () => {
    const modelId = 'org/bounded-partial-projector-variant-switch';
    const staleModelFileName = 'model.Q4_K_M.gguf';
    const activeModelFileName = 'model.Q8_0.gguf';
    const localProjectorFileName = 'mmproj-local-f16.gguf';
    const remoteProjectorFileName = 'mmproj-remote-f16.gguf';
    const staleProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: staleModelFileName,
      fileName: localProjectorFileName,
    });
    const remoteProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      fileName: remoteProjectorFileName,
    });
    const localProjector: ProjectorArtifact = {
      id: staleProjectorId,
      ownerModelId: modelId,
      ownerVariantId: staleModelFileName,
      repoId: modelId,
      fileName: localProjectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${localProjectorFileName}`,
      hfRevision: 'main',
      sha256: PROJECTOR_SHA256,
      size: 1024,
      localPath: 'mmproj-local-f16.gguf',
      lifecycleStatus: 'downloaded',
      matchStatus: 'matched',
    };
    const refreshTarget: ModelMetadata = {
      id: modelId,
      name: 'Bounded Partial Projector Variant Switch',
      author: 'org',
      size: 4 * 1024 * 1024 * 1024,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${activeModelFileName}`,
      hfRevision: 'main',
      resolvedFileName: activeModelFileName,
      sha256: TREE_SHA256,
      downloadIntegrity: {
        kind: 'sha256',
        sha256: TREE_SHA256,
        sizeBytes: 4 * 1024 * 1024 * 1024,
        checkedAt: 1234,
      },
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      activeVariantId: activeModelFileName,
      chatModalities: ['text', 'vision'],
      projectorCandidates: [localProjector],
      selectedProjectorId: localProjector.id,
      multimodalReadiness: {
        modelId,
        variantId: staleModelFileName,
        status: 'ready',
        projectorId: localProjector.id,
        support: ['vision'],
        checkedAt: 1234,
      },
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const cursorMatch = url.match(/cursor=tree-page-(\d+)/);
      const pageNumber = cursorMatch ? Number(cursorMatch[1]) : 1;
      const nextPageNumber = pageNumber + 1;

      if (!url.includes('/tree/main?recursive=true') || pageNumber < 1 || pageNumber > 4) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn((headerName: string) => (
            headerName === 'link'
              ? `<https://huggingface.co/api/models/${modelId}/tree/main?recursive=true&cursor=tree-page-${nextPageNumber}>; rel="next"`
              : null
          )),
        },
        json: () => Promise.resolve(
          pageNumber === 4
            ? [{ path: activeModelFileName, size: refreshTarget.size, lfs: { sha256: TREE_SHA256 } }]
            : pageNumber === 2
              ? [{ path: remoteProjectorFileName, size: 2048, lfs: { sha256: DIFFERENT_PROJECTOR_SHA256 } }]
              : [{ path: `README-page-${pageNumber}.md`, size: 1024 }],
        ),
      });
    }) as jest.Mock;
    mockedRegistry.getModel.mockReturnValue(refreshTarget);

    const refreshed = await service.refreshModelMetadata(refreshTarget, { includeDetails: false });

    expect(refreshed.projectorCandidates).toEqual([
      expect.objectContaining({
        id: remoteProjectorId,
        fileName: remoteProjectorFileName,
        sha256: DIFFERENT_PROJECTOR_SHA256,
      }),
    ]);
    expect(refreshed.projectorCandidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: localProjector.id }),
    ]));
    expect(refreshed.selectedProjectorId).toBeUndefined();
    expect(refreshed.multimodalReadiness).toBeUndefined();
  });

  it('clears stale projector state after a complete zero-projector tree probe', async () => {
    const modelId = 'org/complete-zero-projector-clear';
    const modelFileName = 'model.Q4_K_M.gguf';
    const { localModel } = makeDownloadedVisionModelWithProjector({
      modelId,
      modelFileName,
      projectorSha256: PROJECTOR_SHA256,
    });
    const refreshTarget: ModelMetadata = {
      ...localModel,
      hasVerifiedContextWindow: true,
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/tree/main?recursive=true')) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
        json: () => Promise.resolve([
          { path: modelFileName, size: localModel.size, lfs: { sha256: TREE_SHA256 } },
        ]),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(refreshTarget, { includeDetails: true });

    expect(refreshed.projectorCandidates).toBeUndefined();
    expect(refreshed.selectedProjectorId).toBeUndefined();
    expect(refreshed.multimodalReadiness).toBeUndefined();
    expect(refreshed.requiresTreeProbe).toBe(false);
  });

  it('keeps bounded visionConfidence-only refresh from scanning later projector pages', async () => {
    const modelId = 'org/paged-vision-confidence-projector';
    const modelFileName = 'model.Q4_K_M.gguf';
    const projectorFileName = 'mmproj-model-f16.gguf';
    const treePage2Cursor = 'tree-page-2';
    const model: ModelMetadata = {
      id: modelId,
      name: 'Paged Vision Confidence Projector',
      author: 'org',
      size: null,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      visionConfidence: 'inferred',
      requiresTreeProbe: true,
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes(`cursor=${treePage2Cursor}`)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: jest.fn(() => null),
          },
          json: () => Promise.resolve([
            {
              path: projectorFileName,
              size: 1024,
              lfs: { sha256: PROJECTOR_SHA256 },
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
                ? `<https://huggingface.co/api/models/${modelId}/tree/main?recursive=true&cursor=${treePage2Cursor}>; rel="next"`
                : null
            )),
          },
          json: () => Promise.resolve([
            {
              path: modelFileName,
              size: 2 * 1024 * 1024 * 1024,
              lfs: { sha256: TREE_SHA256 },
            },
          ]),
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(model, { includeDetails: false });

    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining(`cursor=${treePage2Cursor}`),
      expect.any(Object),
    );
    expect(refreshed.projectorCandidates).toBeUndefined();
    expect(refreshed.visionConfidence).toBe('inferred');
  });

  it('preserves downloaded projector state when catalog projector ids become repo-level', async () => {
    const modelId = 'org/vision-legacy';
    const modelFileName = 'model.Q4_K_M.gguf';
    const projectorFileName = 'mmproj-model-f16.gguf';
    const legacyProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: modelFileName,
      fileName: projectorFileName,
    });
    const localProjector: ProjectorArtifact = {
      id: legacyProjectorId,
      ownerModelId: modelId,
      ownerVariantId: modelFileName,
      repoId: modelId,
      fileName: projectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${projectorFileName}`,
      hfRevision: 'main',
      sha256: PROJECTOR_SHA256,
      size: 1024,
      localPath: 'mmproj-model-f16.gguf',
      lifecycleStatus: 'downloaded',
      matchStatus: 'matched',
    };
    const localModel: ModelMetadata = {
      id: modelId,
      name: 'Vision Legacy',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      activeVariantId: modelFileName,
      variants: [
        {
          variantId: modelFileName,
          fileName: modelFileName,
          quantizationLabel: 'Q4_K_M',
          size: 2 * 1024 * 1024 * 1024,
        },
      ],
      chatModalities: ['text', 'vision'],
      projectorCandidates: [localProjector],
      selectedProjectorId: localProjector.id,
      multimodalReadiness: {
        modelId,
        variantId: modelFileName,
        status: 'ready',
        projectorId: localProjector.id,
        support: ['vision'],
        checkedAt: 1234,
      },
    };

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeVisionRepo(modelId, modelFileName, projectorFileName)]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('vision legacy');
    const model = result.models[0];
    const projector = model.projectorCandidates?.[0];

    expect(projector?.ownerVariantId).toBeUndefined();
    expect(projector).toEqual(expect.objectContaining({
      localPath: localProjector.localPath,
      lifecycleStatus: 'downloaded',
      sha256: localProjector.sha256,
      size: localProjector.size,
    }));
    expect(projector?.id).not.toBe(localProjector.id);
    expect(model.selectedProjectorId).toBe(projector?.id);
    expect(model.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'ready',
      projectorId: projector?.id,
    }));
  });

  it('does not preserve variant-scoped projector runtime state after switching to another active variant', async () => {
    const modelId = 'org/vision-legacy-variant-switch';
    const modelFileName = 'model.Q4_K_M.gguf';
    const alternateModelFileName = 'model.Q8_0.gguf';
    const projectorFileName = 'mmproj-model-f16.gguf';
    const legacyProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: modelFileName,
      fileName: projectorFileName,
    });
    const localProjector: ProjectorArtifact = {
      id: legacyProjectorId,
      ownerModelId: modelId,
      ownerVariantId: modelFileName,
      repoId: modelId,
      fileName: projectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${projectorFileName}`,
      hfRevision: 'main',
      sha256: PROJECTOR_SHA256,
      size: 1024,
      localPath: 'mmproj-model-f16.gguf',
      lifecycleStatus: 'downloaded',
      matchStatus: 'matched',
    };
    const localModel: ModelMetadata = {
      id: modelId,
      name: 'Vision Legacy Variant Switch',
      author: 'org',
      size: 4 * 1024 * 1024 * 1024,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${alternateModelFileName}`,
      hfRevision: 'main',
      resolvedFileName: alternateModelFileName,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      activeVariantId: alternateModelFileName,
      variants: [
        {
          variantId: modelFileName,
          fileName: modelFileName,
          quantizationLabel: 'Q4_K_M',
          size: 2 * 1024 * 1024 * 1024,
        },
        {
          variantId: alternateModelFileName,
          fileName: alternateModelFileName,
          quantizationLabel: 'Q8_0',
          size: 4 * 1024 * 1024 * 1024,
        },
      ],
      chatModalities: ['text', 'vision'],
      projectorCandidates: [localProjector],
      selectedProjectorId: localProjector.id,
      multimodalReadiness: {
        modelId,
        variantId: modelFileName,
        status: 'ready',
        projectorId: localProjector.id,
        support: ['vision'],
        checkedAt: 1234,
      },
    };

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeVisionRepo(modelId, alternateModelFileName, projectorFileName)]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('vision legacy variant switch');
    const model = result.models[0];
    const projector = model.projectorCandidates?.[0];

    expect(projector?.id).not.toBe(localProjector.id);
    expect(projector?.localPath).toBeUndefined();
    expect(projector?.lifecycleStatus).not.toBe('downloaded');
    expect(model.selectedProjectorId).toBeUndefined();
    expect(model.multimodalReadiness).toBeUndefined();
  });

  it('does not preserve variant-scoped local projector state for a different active variant when remote has no candidates', async () => {
    const modelId = 'org/vision-legacy-variant-no-projector';
    const modelFileName = 'model.Q4_K_M.gguf';
    const alternateModelFileName = 'model.Q8_0.gguf';
    const projectorFileName = 'mmproj-model-f16.gguf';
    const legacyProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: modelFileName,
      fileName: projectorFileName,
    });
    const localProjector: ProjectorArtifact = {
      id: legacyProjectorId,
      ownerModelId: modelId,
      ownerVariantId: modelFileName,
      repoId: modelId,
      fileName: projectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${projectorFileName}`,
      hfRevision: 'main',
      sha256: PROJECTOR_SHA256,
      size: 1024,
      localPath: 'mmproj-model-f16.gguf',
      lifecycleStatus: 'downloaded',
      matchStatus: 'matched',
    };
    const localModel: ModelMetadata = {
      id: modelId,
      name: 'Vision Legacy Variant Without Projector',
      author: 'org',
      size: 4 * 1024 * 1024 * 1024,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${alternateModelFileName}`,
      hfRevision: 'main',
      resolvedFileName: alternateModelFileName,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      activeVariantId: alternateModelFileName,
      chatModalities: ['text', 'vision'],
      projectorCandidates: [localProjector],
      selectedProjectorId: localProjector.id,
      multimodalReadiness: {
        modelId,
        variantId: modelFileName,
        status: 'ready',
        projectorId: localProjector.id,
        support: ['vision'],
        checkedAt: 1234,
      },
    };

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{
          id: modelId,
          pipeline_tag: 'text-generation',
          tags: ['gguf', 'chat', 'vision'],
          siblings: [{ rfilename: alternateModelFileName, size: 4 * 1024 * 1024 * 1024 }],
        }]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('vision legacy variant without projector');
    const model = result.models[0];

    expect(model.projectorCandidates).toBeUndefined();
    expect(model.selectedProjectorId).toBeUndefined();
    expect(model.multimodalReadiness).toBeUndefined();
  });

  it('does not preserve projector runtime state for exact id matches with conflicting stable identity', async () => {
    const modelId = 'org/vision-projector-id-conflict';
    const {
      localModel,
      localProjector,
      modelFileName,
      projectorFileName,
    } = makeDownloadedVisionModelWithProjector({
      modelId,
      projectorSha256: PROJECTOR_SHA256,
    });
    const conflictingProjector: ProjectorArtifact = {
      ...localProjector,
      ownerModelId: 'org/different-owner',
      repoId: 'org/different-owner',
      localPath: 'stale-conflicting-projector.gguf',
      resumeData: 'stale-resume-token',
      downloadProgress: 0.5,
      lifecycleStatus: 'paused',
      matchStatus: 'failed',
      matchReason: 'stale_identity_conflict',
    };
    const conflictingLocalModel: ModelMetadata = {
      ...localModel,
      projectorCandidates: [conflictingProjector],
      selectedProjectorId: conflictingProjector.id,
      multimodalReadiness: {
        modelId,
        variantId: modelFileName,
        status: 'ready',
        projectorId: conflictingProjector.id,
        support: ['vision'],
        checkedAt: 1234,
      },
    };

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? conflictingLocalModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeVisionRepo(modelId, modelFileName, projectorFileName, {
          size: conflictingProjector.size ?? undefined,
          sha256: conflictingProjector.sha256,
        })]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('vision projector id conflict');
    const model = result.models[0];
    const projector = model.projectorCandidates?.[0];

    expect(projector?.id).toBe(conflictingProjector.id);
    expect(projector).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      matchStatus: 'matched',
      ownerModelId: modelId,
      repoId: modelId,
    }));
    expect(projector?.localPath).toBeUndefined();
    expect(projector?.resumeData).toBeUndefined();
    expect(projector?.downloadProgress).toBeUndefined();
    expect(projector?.matchReason).not.toBe(conflictingProjector.matchReason);
    expect(model.selectedProjectorId).toBeUndefined();
    expect(model.multimodalReadiness?.status).not.toBe('ready');
    expect(model.multimodalReadiness?.projectorId).not.toBe(conflictingProjector.id);

    const remoteProjector = projector as ProjectorArtifact;
    const directMerge = (service as unknown as {
      mergeProjectorMetadataWithLocalState: (
        remoteModel: ModelMetadata,
        localModel: ModelMetadata,
        shouldResetLocalDownloadState: boolean,
      ) => {
        selectedProjectorId?: string;
        multimodalReadiness?: MultimodalReadinessState;
        projectorCandidates?: ProjectorArtifact[];
      };
    }).mergeProjectorMetadataWithLocalState(
      {
        ...localModel,
        projectorCandidates: [remoteProjector],
        selectedProjectorId: remoteProjector.id,
        multimodalReadiness: {
          modelId,
          variantId: modelFileName,
          status: 'ready',
          projectorId: remoteProjector.id,
          support: ['vision'],
          checkedAt: 5678,
        },
      },
      conflictingLocalModel,
      false,
    );

    expect(directMerge.selectedProjectorId).toBeUndefined();
    expect(directMerge.multimodalReadiness?.status).not.toBe('ready');
    expect(directMerge.multimodalReadiness?.projectorId).not.toBe(conflictingProjector.id);

    const legacyProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: modelFileName,
      fileName: projectorFileName,
    });
    const legacyCompatibleProjector: ProjectorArtifact = {
      ...localProjector,
      id: legacyProjectorId,
      ownerVariantId: modelFileName,
      localPath: `legacy-${projectorFileName}`,
    };
    const directMergeWithBlockedIncomingSelection = (service as unknown as {
      mergeProjectorMetadataWithLocalState: (
        remoteModel: ModelMetadata,
        localModel: ModelMetadata,
        shouldResetLocalDownloadState: boolean,
      ) => {
        selectedProjectorId?: string;
        multimodalReadiness?: MultimodalReadinessState;
      };
    }).mergeProjectorMetadataWithLocalState(
      {
        ...localModel,
        projectorCandidates: [remoteProjector],
        selectedProjectorId: remoteProjector.id,
        multimodalReadiness: {
          modelId,
          variantId: modelFileName,
          status: 'ready',
          projectorId: remoteProjector.id,
          support: ['vision'],
          checkedAt: 3456,
        },
      },
      {
        ...localModel,
        projectorCandidates: [conflictingProjector, legacyCompatibleProjector],
        selectedProjectorId: legacyCompatibleProjector.id,
        multimodalReadiness: {
          modelId,
          variantId: modelFileName,
          status: 'ready',
          projectorId: legacyCompatibleProjector.id,
          support: ['vision'],
          checkedAt: 9012,
        },
      },
      false,
    );

    expect(directMergeWithBlockedIncomingSelection.selectedProjectorId).toBe(remoteProjector.id);
    expect(directMergeWithBlockedIncomingSelection.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'ready',
      projectorId: remoteProjector.id,
      checkedAt: 9012,
    }));
  });

  it('does not fall back to a different local ready projector when the incoming selected projector is blocked', () => {
    const modelId = 'org/vision-blocked-selected-projector-local-fallback';
    const modelFileName = 'model.Q4_K_M.gguf';
    const selectedProjectorFileName = 'mmproj-selected-f16.gguf';
    const localReadyProjectorFileName = 'mmproj-local-ready-f16.gguf';
    const selectedProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      fileName: selectedProjectorFileName,
    });
    const localReadyProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      fileName: localReadyProjectorFileName,
    });
    const remoteSelectedProjector: ProjectorArtifact = {
      id: selectedProjectorId,
      ownerModelId: modelId,
      repoId: modelId,
      fileName: selectedProjectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${selectedProjectorFileName}`,
      hfRevision: 'main',
      sha256: PROJECTOR_SHA256,
      size: 1024,
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    };
    const conflictingLocalSelectedProjector: ProjectorArtifact = {
      ...remoteSelectedProjector,
      ownerModelId: 'org/different-owner',
      repoId: 'org/different-owner',
      localPath: 'stale-selected-projector.gguf',
      lifecycleStatus: 'downloaded',
    };
    const remoteLocalReadyProjector: ProjectorArtifact = {
      id: localReadyProjectorId,
      ownerModelId: modelId,
      repoId: modelId,
      fileName: localReadyProjectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${localReadyProjectorFileName}`,
      hfRevision: 'main',
      sha256: DIFFERENT_PROJECTOR_SHA256,
      size: 2048,
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    };
    const localReadyProjector: ProjectorArtifact = {
      ...remoteLocalReadyProjector,
      localPath: 'local-ready-projector.gguf',
      lifecycleStatus: 'downloaded',
    };
    const baseModel: ModelMetadata = {
      id: modelId,
      name: 'Blocked Selected Projector Local Fallback',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text', 'vision'],
    };
    const directMerge = (service as unknown as {
      mergeProjectorMetadataWithLocalState: (
        remoteModel: ModelMetadata,
        localModel: ModelMetadata,
        shouldResetLocalDownloadState: boolean,
      ) => {
        selectedProjectorId?: string;
        multimodalReadiness?: MultimodalReadinessState;
      };
    }).mergeProjectorMetadataWithLocalState(
      {
        ...baseModel,
        projectorCandidates: [remoteSelectedProjector, remoteLocalReadyProjector],
        selectedProjectorId,
        multimodalReadiness: {
          modelId,
          variantId: modelFileName,
          status: 'ready',
          projectorId: selectedProjectorId,
          support: ['vision'],
          checkedAt: 3456,
        },
      },
      {
        ...baseModel,
        projectorCandidates: [conflictingLocalSelectedProjector, localReadyProjector],
        selectedProjectorId: localReadyProjectorId,
        multimodalReadiness: {
          modelId,
          variantId: modelFileName,
          status: 'ready',
          projectorId: localReadyProjectorId,
          support: ['vision'],
          checkedAt: 9012,
        },
      },
      false,
    );

    expect(directMerge.selectedProjectorId).toBeUndefined();
    expect(directMerge.multimodalReadiness).toBeUndefined();
  });

  it('preserves local projector readiness when the catalog selected projector id is stale', () => {
    const modelId = 'org/vision-stale-remote-selected-projector';
    const {
      localModel,
      localProjector,
      modelFileName,
    } = makeDownloadedVisionModelWithProjector({
      modelId,
      projectorSha256: PROJECTOR_SHA256,
    });
    const staleCatalogSelectedProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      fileName: 'stale-mmproj-no-longer-listed.gguf',
    });
    const remoteProjector: ProjectorArtifact = {
      ...localProjector,
      localPath: undefined,
      lifecycleStatus: 'available',
    };

    const directMerge = (service as unknown as {
      mergeProjectorMetadataWithLocalState: (
        remoteModel: ModelMetadata,
        localModel: ModelMetadata,
        shouldResetLocalDownloadState: boolean,
      ) => {
        selectedProjectorId?: string;
        multimodalReadiness?: MultimodalReadinessState;
      };
    }).mergeProjectorMetadataWithLocalState(
      {
        ...localModel,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        localPath: undefined,
        downloadedAt: undefined,
        downloadProgress: 0,
        projectorCandidates: [remoteProjector],
        selectedProjectorId: staleCatalogSelectedProjectorId,
        multimodalReadiness: {
          modelId,
          variantId: modelFileName,
          status: 'ready',
          projectorId: staleCatalogSelectedProjectorId,
          support: ['vision'],
          checkedAt: 5678,
        },
      },
      localModel,
      false,
    );

    expect(directMerge.selectedProjectorId).toBe(localProjector.id);
    expect(directMerge.multimodalReadiness).toEqual(expect.objectContaining({
      status: 'ready',
      projectorId: localProjector.id,
      checkedAt: 1234,
    }));
  });

  it.each([
    ['paused', 0.42],
    ['failed', 0.67],
    ['downloading', 0.18],
  ] as const)(
    'preserves %s compatible projector runtime state when catalog projector ids become repo-level',
    async (lifecycleStatus, downloadProgress) => {
      const modelId = `org/vision-${lifecycleStatus}-legacy`;
      const modelFileName = 'model.Q4_K_M.gguf';
      const projectorFileName = 'mmproj-model-f16.gguf';
      const legacyProjectorId = buildProjectorArtifactId({
        repoId: modelId,
        hfRevision: 'main',
        ownerVariantId: modelFileName,
        fileName: projectorFileName,
      });
      const localProjector: ProjectorArtifact = {
        id: legacyProjectorId,
        ownerModelId: modelId,
        ownerVariantId: modelFileName,
        repoId: modelId,
        fileName: projectorFileName,
        downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${projectorFileName}`,
        hfRevision: 'main',
        sha256: PROJECTOR_SHA256,
        size: 1024,
        localPath: `partial-${projectorFileName}`,
        resumeData: `resume-${lifecycleStatus}`,
        downloadProgress,
        lifecycleStatus,
        matchStatus: 'failed',
        matchReason: `${lifecycleStatus}_runtime_reason`,
      };
      const localModel: ModelMetadata = {
        id: modelId,
        name: 'Vision Runtime Legacy',
        author: 'org',
        size: 2 * 1024 * 1024 * 1024,
        downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
        hfRevision: 'main',
        resolvedFileName: modelFileName,
        fitsInRam: true,
        accessState: ModelAccessState.PUBLIC,
        isGated: false,
        isPrivate: false,
        lifecycleStatus: LifecycleStatus.DOWNLOADED,
        downloadProgress: 1,
        activeVariantId: modelFileName,
        variants: [
          {
            variantId: modelFileName,
            fileName: modelFileName,
            quantizationLabel: 'Q4_K_M',
            size: 2 * 1024 * 1024 * 1024,
          },
        ],
        chatModalities: ['text', 'vision'],
        projectorCandidates: [localProjector],
        selectedProjectorId: localProjector.id,
        multimodalReadiness: {
          modelId,
          variantId: modelFileName,
          status: lifecycleStatus === 'downloading' ? 'projector_downloading' : 'failed',
          projectorId: localProjector.id,
          support: ['vision'],
          checkedAt: 1234,
        },
      };

      mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve([makeVisionRepo(modelId, modelFileName, projectorFileName, {
            size: localProjector.size ?? undefined,
            sha256: localProjector.sha256,
          })]),
        }),
      ) as jest.Mock;

      const result = await service.searchModels(`vision ${lifecycleStatus} legacy`);
      const model = result.models[0];
      const projector = model.projectorCandidates?.[0];

      expect(projector?.ownerVariantId).toBeUndefined();
      expect(projector?.id).not.toBe(localProjector.id);
      expect(projector).toEqual(expect.objectContaining({
        localPath: localProjector.localPath,
        resumeData: localProjector.resumeData,
        downloadProgress,
        lifecycleStatus,
        matchStatus: localProjector.matchStatus,
        matchReason: localProjector.matchReason,
        sha256: localProjector.sha256,
        size: localProjector.size,
      }));
      expect(model.selectedProjectorId).toBe(projector?.id);
      expect(model.multimodalReadiness?.projectorId).toBe(projector?.id);
    },
  );

  it('resets downloaded projector state when catalog projector sha256 changes', async () => {
    const modelId = 'org/vision-projector-sha-reset';
    const {
      localModel,
      localProjector,
      modelFileName,
      projectorFileName,
    } = makeDownloadedVisionModelWithProjector({
      modelId,
      projectorSha256: PROJECTOR_SHA256,
    });

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeVisionRepo(modelId, modelFileName, projectorFileName, {
          size: localProjector.size ?? undefined,
          sha256: DIFFERENT_PROJECTOR_SHA256,
        })]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('vision projector sha reset');
    const projector = result.models[0].projectorCandidates?.[0];

    expect(projector).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      size: localProjector.size,
      sha256: DIFFERENT_PROJECTOR_SHA256,
    }));
    expect(projector?.localPath).toBeUndefined();
    expect(result.models[0].multimodalReadiness).toBeUndefined();
  });

  it('resets downloaded projector state when catalog projector size changes', async () => {
    const modelId = 'org/vision-projector-size-reset';
    const remoteProjectorSize = 1024;
    const {
      localModel,
      modelFileName,
      projectorFileName,
    } = makeDownloadedVisionModelWithProjector({
      modelId,
      projectorSize: 2048,
      projectorSha256: PROJECTOR_SHA256,
    });

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeVisionRepo(modelId, modelFileName, projectorFileName, {
          size: remoteProjectorSize,
          sha256: PROJECTOR_SHA256,
        })]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('vision projector size reset');
    const projector = result.models[0].projectorCandidates?.[0];

    expect(projector).toEqual(expect.objectContaining({
      lifecycleStatus: 'available',
      size: remoteProjectorSize,
      sha256: PROJECTOR_SHA256,
    }));
    expect(projector?.localPath).toBeUndefined();
    expect(result.models[0].multimodalReadiness).toBeUndefined();
  });

  it('resets downloaded projector state when catalog projector download URL changes', async () => {
    const modelId = 'org/vision-projector-url-reset';
    const localProjectorDownloadUrl = `https://huggingface.co/${modelId}/resolve/main/mmproj-model-f16.gguf?download=true`;
    const {
      localModel,
      modelFileName,
      projectorFileName,
    } = makeDownloadedVisionModelWithProjector({
      modelId,
      projectorDownloadUrl: localProjectorDownloadUrl,
      projectorSha256: PROJECTOR_SHA256,
    });

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeVisionRepo(modelId, modelFileName, projectorFileName, {
          sha256: PROJECTOR_SHA256,
        })]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('vision projector url reset');
    const projector = result.models[0].projectorCandidates?.[0];

    expect(projector).toEqual(expect.objectContaining({
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${projectorFileName}`,
      lifecycleStatus: 'available',
      size: 1024,
      sha256: PROJECTOR_SHA256,
    }));
    expect(projector?.localPath).toBeUndefined();
    expect(result.models[0].multimodalReadiness).toBeUndefined();
  });

  it('drops remote readiness remaps for projector metadata conflicts', () => {
    const catalogInternals = service as unknown as {
      resolveMergedMultimodalReadiness: (
        modelId: string,
        remoteReadiness: MultimodalReadinessState | undefined,
        localReadiness: MultimodalReadinessState | undefined,
        candidateIds: Set<string>,
        localToRemoteProjectorIds: Map<string, string>,
        selectedProjectorId?: string,
        blockedProjectorIds?: Set<string>,
      ) => MultimodalReadinessState | undefined;
    };
    const readiness: MultimodalReadinessState = {
      modelId: 'org/vision-projector-remote-readiness-reset',
      status: 'ready',
      projectorId: 'local-projector',
      support: ['vision'],
      checkedAt: 1234,
    };

    expect(catalogInternals.resolveMergedMultimodalReadiness(
      readiness.modelId,
      readiness,
      undefined,
      new Set(['remote-projector']),
      new Map([['local-projector', 'remote-projector']]),
      'remote-projector',
      new Set(['local-projector', 'remote-projector']),
    )).toBeUndefined();
  });

  it('hydrates already-downloaded text-only registry models with fresh vision metadata without projector download state', async () => {
    const modelId = 'org/newly-vision-capable';
    const modelFileName = 'model.Q4_K_M.gguf';
    const projectorFileName = 'mmproj-model-f16.gguf';
    const localModel: ModelMetadata = {
      id: modelId,
      name: 'Newly Vision Capable',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      localPath: 'newly-vision-capable.Q4_K_M.gguf',
      downloadedAt: 1234,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      chatModalities: ['text'],
    };

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeVisionRepo(modelId, modelFileName, projectorFileName)]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('vision capable');
    const model = result.models[0];
    const projector = model.projectorCandidates?.[0];

    expect(model).toEqual(expect.objectContaining({
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      localPath: localModel.localPath,
      downloadedAt: localModel.downloadedAt,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    }));
    expect(projector).toEqual(expect.objectContaining({
      ownerModelId: modelId,
      repoId: modelId,
      fileName: projectorFileName,
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    }));
    expect(projector?.localPath).toBeUndefined();
    expect(model.selectedProjectorId).toBeUndefined();
    expect(model.multimodalReadiness).toBeUndefined();
  });

  it('keeps local-only vision metadata visible for downloaded models after anonymous cache sanitization', async () => {
    const localModel: ModelMetadata = {
      id: 'org/local-runtime-vision',
      name: 'Local Runtime Vision',
      author: 'org',
      size: 2 * 1024 * 1024 * 1024,
      downloadUrl: 'https://huggingface.co/org/local-runtime-vision/resolve/main/model.Q4_K_M.gguf',
      hfRevision: 'main',
      resolvedFileName: 'model.Q4_K_M.gguf',
      localPath: 'local-runtime-vision.Q4_K_M.gguf',
      downloadedAt: 1234,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'gguf_metadata',
      visionConfidence: 'verified',
    };

    mockedRegistry.getModels.mockReturnValue([localModel]);
    mockedRegistry.getModel.mockImplementation((id) => (id === localModel.id ? localModel : undefined));

    const firstResult = await service.getLocalModels();
    const secondResult = await service.getLocalModels();

    expect(firstResult[0]).toEqual(expect.objectContaining({
      chatModalities: ['text', 'vision'],
      visionSource: 'gguf_metadata',
      visionConfidence: 'verified',
      localPath: localModel.localPath,
    }));
    expect(secondResult[0]).toEqual(expect.objectContaining({
      chatModalities: ['text', 'vision'],
      visionSource: 'gguf_metadata',
      visionConfidence: 'verified',
      localPath: localModel.localPath,
    }));
  });

  it('drops stale local-only vision metadata when catalog identity resets local download state', async () => {
    const modelId = 'org/reset-local-metadata';
    const localModel: ModelMetadata = {
      id: modelId,
      name: 'Reset Local Metadata',
      author: 'org',
      size: 1024,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/old.Q4_K_M.gguf`,
      hfRevision: 'main',
      resolvedFileName: 'old.Q4_K_M.gguf',
      localPath: 'old.Q4_K_M.gguf',
      downloadedAt: 1234,
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'gguf_metadata',
      visionConfidence: 'verified',
    };

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeTextGenerationRepo(modelId)]),
      }),
    ) as jest.Mock;

    const result = await service.searchModels('reset local vision');
    const model = result.models[0];

    expect(model).toEqual(expect.objectContaining({
      chatModalities: ['text'],
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    }));
    expect(model.localPath).toBeUndefined();
    expect(model.downloadedAt).toBeUndefined();
    expect(model.visionSource).toBeUndefined();
    expect(model.visionConfidence).toBeUndefined();
  });

  it('keeps projector-aware likely OOM through tree merge, cache, and local recomputes', async () => {
    const modelId = 'org/projector-memory-rv03';
    const modelFileName = 'model.Q4_K_M.gguf';
    const projectorFileName = 'mmproj-model-f16.gguf';
    const baseSizeBytes = 1 * 1024 * 1024 * 1024;
    const projectorSizeBytes = 4 * 1024 * 1024 * 1024;
    const { localProjector } = makeDownloadedVisionModelWithProjector({
      modelId,
      modelFileName,
      projectorFileName,
      projectorSize: projectorSizeBytes,
      projectorSha256: PROJECTOR_SHA256,
    });
    const localModel: ModelMetadata = {
      id: modelId,
      name: 'Projector Memory RV03',
      author: 'org',
      size: baseSizeBytes,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      localPath: modelFileName,
      downloadedAt: 1234,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      metadataTrust: 'trusted_remote',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [localProjector],
      selectedProjectorId: localProjector.id,
    };

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * 1024 * 1024 * 1024);
    mockedRegistry.getModels.mockReturnValue([localModel]);
    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          json: () => Promise.resolve([
            { path: modelFileName, size: baseSizeBytes, lfs: { sha256: TREE_SHA256 } },
            { path: projectorFileName, size: projectorSizeBytes, lfs: { sha256: PROJECTOR_SHA256 } },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([{
          id: modelId,
          pipeline_tag: 'text-generation',
          tags: ['gguf', 'chat', 'vision'],
          siblings: [{ rfilename: modelFileName }],
        }]),
      });
    }) as jest.Mock;

    const onlineResult = await service.searchModels('rv03 remote');
    const cachedResult = service.getCachedSearchResult('rv03 remote');
    const cachedModel = service.getCachedModel(modelId);

    (hardwareListenerService.getCurrentStatus as jest.Mock).mockReturnValue({ isConnected: false });
    const localSearchResult = await service.searchModels('Projector Memory RV03');

    for (const model of [
      onlineResult.models[0],
      cachedResult?.models[0],
      cachedModel,
      localSearchResult.models[0],
    ]) {
      expect(model).toEqual(expect.objectContaining({
        id: modelId,
        fitsInRam: false,
        memoryFitDecision: 'likely_oom',
      }));
    }
  });

  it('counts a preserved selected projector during ambiguous tree memory-fit recomputes', async () => {
    const modelId = 'org/selected-projector-memory-rv03';
    const modelFileName = 'model.Q4_K_M.gguf';
    const selectedProjectorFileName = 'mmproj-alpha-f16.gguf';
    const otherProjectorFileName = 'mmproj-beta-f16.gguf';
    const baseSizeBytes = 1 * 1024 * 1024 * 1024;
    const selectedProjectorSizeBytes = 4 * 1024 * 1024 * 1024;
    const otherProjectorSizeBytes = 512 * 1024 * 1024;
    const selectedProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      fileName: selectedProjectorFileName,
    });
    const otherProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      fileName: otherProjectorFileName,
    });
    const localModel: ModelMetadata = {
      id: modelId,
      name: 'Selected Projector Memory RV03',
      author: 'org',
      size: baseSizeBytes,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${modelFileName}`,
      hfRevision: 'main',
      resolvedFileName: modelFileName,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      metadataTrust: 'trusted_remote',
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        {
          id: selectedProjectorId,
          ownerModelId: modelId,
          repoId: modelId,
          fileName: selectedProjectorFileName,
          downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${selectedProjectorFileName}`,
          hfRevision: 'main',
          size: selectedProjectorSizeBytes,
          lifecycleStatus: 'available',
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        },
        {
          id: otherProjectorId,
          ownerModelId: modelId,
          repoId: modelId,
          fileName: otherProjectorFileName,
          downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${otherProjectorFileName}`,
          hfRevision: 'main',
          size: otherProjectorSizeBytes,
          lifecycleStatus: 'available',
          matchStatus: 'ambiguous',
          matchReason: 'multiple_projector_candidates',
        },
      ],
      selectedProjectorId,
    };

    (DeviceInfo.getTotalMemory as jest.Mock).mockResolvedValue(4 * 1024 * 1024 * 1024);
    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          json: () => Promise.resolve([
            { path: modelFileName, size: baseSizeBytes, lfs: { sha256: TREE_SHA256 } },
            { path: selectedProjectorFileName, size: selectedProjectorSizeBytes, lfs: { sha256: PROJECTOR_SHA256 } },
            { path: otherProjectorFileName, size: otherProjectorSizeBytes, lfs: { sha256: DIFFERENT_PROJECTOR_SHA256 } },
          ]),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([{
          id: modelId,
          pipeline_tag: 'text-generation',
          tags: ['gguf', 'chat', 'vision'],
          siblings: [{ rfilename: modelFileName }],
        }]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('selected projector rv03');
    const model = result.models[0];

    expect(model).toEqual(expect.objectContaining({
      id: modelId,
      selectedProjectorId,
      fitsInRam: false,
      memoryFitDecision: 'likely_oom',
    }));
    expect(model.variants?.find((variant) => variant.fileName === modelFileName)).toEqual(expect.objectContaining({
      ramFit: 'likely_oom',
    }));
  });

  it('keeps size-known gated repos authorized when access validation temporarily fails with a non-auth error', async () => {
    await huggingFaceTokenService.saveToken('hf_test_token');

    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/resolve/main/model.Q4_K_M.gguf')) {
        return Promise.resolve({
          ok: false,
          status: 429,
        });
      }

      if (String(input).includes('/tree/main?recursive=true')) {
        return Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve([]),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([makeSizedGatedRepo('org/size-known-but-unvalidated')]),
      });
    }) as jest.Mock;

    const result = await service.searchModels('phi');

    expect(result.models).toHaveLength(1);
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTHORIZED);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/resolve/main/model.Q4_K_M.gguf');
    expect((global.fetch as jest.Mock).mock.calls[1][1]).toMatchObject({ method: 'HEAD' });
    expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('/tree/main?recursive=true');
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
    expect(result.models[0].accessState).toBe(ModelAccessState.AUTHORIZED);

    const refreshed = await service.refreshModelMetadata(result.models[0], { includeDetails: false });

    expect(refreshed.accessState).toBe(ModelAccessState.AUTHORIZED);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain('/resolve/main/model.Q4_K_M.gguf');
    expect((global.fetch as jest.Mock).mock.calls[2][1]).toMatchObject({ method: 'GET' });
    expect((global.fetch as jest.Mock).mock.calls[3][0]).toContain('/tree/main?recursive=true');
  });
});
