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
