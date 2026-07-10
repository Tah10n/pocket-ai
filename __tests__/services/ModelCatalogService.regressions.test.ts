import DeviceInfo from 'react-native-device-info';
import { ModelCatalogService } from '../../src/services/ModelCatalogService';
import { huggingFaceTokenService } from '../../src/services/HuggingFaceTokenService';
import { hardwareListenerService } from '../../src/services/HardwareListenerService';
import { registry } from '../../src/services/LocalStorageRegistry';
import { EngineStatus, LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { MultimodalReadinessState, ProjectorArtifact } from '../../src/types/multimodal';
import {
  resolveEffectiveActiveVariantNativeSupport,
  resolveModelNativeMultimodalSupport,
} from '../../src/utils/modelCapabilities';
import { resolveEffectiveInputCapabilities } from '../../src/utils/modelInputCapabilities';
import { buildProjectorArtifactId } from '../../src/utils/modelProjectors';
import { applyModelVariantSelection } from '../../src/utils/modelVariants';

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

function makeDownloadedAudioModelWithProjector(options: {
  modelId: string;
  modelFileName?: string;
  projectorFileName?: string;
  projectorSize?: number;
  projectorSha256?: string;
}): {
  localModel: ModelMetadata;
  localProjector: ProjectorArtifact;
  modelFileName: string;
  projectorFileName: string;
} {
  const modelFileName = options.modelFileName ?? 'audio-model.Q4_K_M.gguf';
  const projectorFileName = options.projectorFileName ?? 'mmproj-audio-model-f16.gguf';
  const projectorId = buildProjectorArtifactId({
    repoId: options.modelId,
    hfRevision: 'main',
    fileName: projectorFileName,
  });
  const projectorDownloadUrl = `https://huggingface.co/${options.modelId}/resolve/main/${projectorFileName}`;
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
    name: 'Downloaded Audio Model',
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
    chatModalities: ['text', 'audio'],
    inputCapabilities: {
      detectedAt: 1234,
      declared: {
        image: 'unknown',
        audio: 'supported',
        video: 'unknown',
      },
      evidence: [{ source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' }],
    },
    artifactRole: 'primary_chat_model',
    artifacts: [{
      id: projectorId,
      kind: 'multimodal_projector',
      requiredFor: ['audio'],
      hfRevision: 'main',
      remoteFileName: projectorFileName,
      downloadUrl: projectorDownloadUrl,
      sizeBytes: options.projectorSize ?? 1024,
      ...(options.projectorSha256 ? { sha256: options.projectorSha256 } : {}),
      localPath: `local-${projectorFileName}`,
      installState: 'installed',
    }],
    projectorCandidates: [localProjector],
    selectedProjectorId: localProjector.id,
    multimodalReadiness: {
      modelId: options.modelId,
      variantId: modelFileName,
      status: 'ready',
      projectorId: localProjector.id,
      support: ['audio'],
      requestedSupport: ['audio'],
      checkedAt: 1234,
    },
  };

  return { localModel, localProjector, modelFileName, projectorFileName };
}

function mergeModelWithRegistryForTest(
  service: ModelCatalogService,
  remoteModel: ModelMetadata,
): ModelMetadata | undefined {
  return (service as unknown as {
    mergeModelWithRegistry: (
      model: ModelMetadata,
      memoryFitContext: { totalMemoryBytes: number; systemMemorySnapshot: null },
    ) => ModelMetadata | undefined;
  }).mergeModelWithRegistry(remoteModel, {
    totalMemoryBytes: 4 * 1024 * 1024 * 1024,
    systemMemorySnapshot: null,
  });
}

function resolveComposerNativeInputs(model: ModelMetadata): { image: boolean; audio: boolean } {
  const capabilities = resolveEffectiveInputCapabilities({
    model,
    engineState: {
      status: EngineStatus.READY,
      activeModelId: model.id,
      loadProgress: 1,
    },
  });

  return { image: capabilities.image, audio: capabilities.audio };
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

  it('preserves audio capability evidence while full tree refresh collects projector candidates', async () => {
    const modelId = 'org/audio-projector-refresh';
    const modelFileName = 'audio-model.Q4_K_M.gguf';
    const projectorFileName = 'mmproj-audio-model-f16.gguf';
    const treePage2Cursor = 'tree-page-2';
    const model: ModelMetadata = {
      id: modelId,
      name: 'Audio Projector Refresh',
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
      chatModalities: ['text'],
      hasVerifiedContextWindow: true,
      inputCapabilities: {
        detectedAt: 100,
        declared: {
          image: 'unknown',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [
          { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
        ],
      },
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
              size: model.size,
              lfs: { sha256: TREE_SHA256 },
            },
          ]),
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(model);
    const projectorArtifact = refreshed.artifacts?.find((artifact) => artifact.kind === 'multimodal_projector');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`cursor=${treePage2Cursor}`),
      expect.any(Object),
    );
    expect(refreshed.chatModalities).toEqual(['text', 'audio']);
    expect(refreshed.inputCapabilities?.declared).toEqual({
      image: 'unknown',
      audio: 'supported',
      video: 'unknown',
    });
    expect(refreshed.inputCapabilities?.evidence).toEqual(expect.arrayContaining([
      { source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' },
      { source: 'projector', value: projectorFileName, confidence: 'medium' },
    ]));
    expect(refreshed.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      fileName: projectorFileName,
      matchStatus: 'matched',
    }));
    expect(projectorArtifact?.requiredFor).toEqual(['audio']);
    expect(refreshed.visionSource).toBeUndefined();
    expect(refreshed.visionConfidence).toBeUndefined();
  });

  it('does not resurrect stale model.gguf fallback metadata after a final projector-only tree probe', async () => {
    const modelId = 'test-org/projector-only-repo';
    const staleModel: ModelMetadata = {
      id: modelId,
      name: 'Projector-only Repo',
      author: 'test-org',
      size: null,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/model.gguf`,
      fitsInRam: null,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: 'stale-model.gguf',
      downloadedAt: 1234,
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: 2 * 1024 * 1024 * 1024,
        checkedAt: 1234,
      },
      resumeData: 'stale-resume-data',
      downloadErrorCode: 'stale_error',
      downloadErrorMessage: 'stale error',
      downloadErrorAt: 1235,
      hfRevision: 'main',
      resolvedFileName: 'model.gguf',
      activeVariantId: 'model.gguf',
      requiresTreeProbe: true,
      chatModalities: ['text', 'vision'],
      artifactRole: 'primary_chat_model',
      visionSource: 'catalog_metadata',
      visionConfidence: 'inferred',
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
          {
            path: 'mmproj-model-f16.gguf',
            size: 1024,
            lfs: { sha256: PROJECTOR_SHA256 },
          },
        ]),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(staleModel, { includeDetails: false });

    expect(refreshed.resolvedFileName).toBeUndefined();
    expect(refreshed.activeVariantId).toBeUndefined();
    expect(refreshed.downloadUrl).toBe(`https://huggingface.co/${modelId}`);
    expect(refreshed.requiresTreeProbe).toBe(false);
    expect(refreshed.lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(refreshed.downloadProgress).toBe(0);
    expect(refreshed.localPath).toBeUndefined();
    expect(refreshed.downloadedAt).toBeUndefined();
    expect(refreshed.downloadIntegrity).toBeUndefined();
    expect(refreshed.resumeData).toBeUndefined();
    expect(refreshed.downloadErrorCode).toBeUndefined();
    expect(refreshed.downloadErrorMessage).toBeUndefined();
    expect(refreshed.downloadErrorAt).toBeUndefined();
    expect(refreshed.projectorCandidates).toBeUndefined();
    expect(refreshed.chatModalities).not.toContain('vision');
    expect(service.getCachedModel(modelId)).toBeNull();
  });

  it('clears audio modality and projector artifacts after a final audio-only tree probe miss', async () => {
    const modelId = 'test-org/audio-tree-probe-miss';
    const { localModel } = makeDownloadedAudioModelWithProjector({ modelId });
    const staleModel: ModelMetadata = {
      ...localModel,
      requiresTreeProbe: true,
      visionSource: undefined,
      visionConfidence: undefined,
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
          {
            path: 'mmproj-audio-model-f16.gguf',
            size: 1024,
            lfs: { sha256: PROJECTOR_SHA256 },
          },
        ]),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(staleModel, { includeDetails: false });
    const nativeSupport = resolveModelNativeMultimodalSupport(refreshed);

    expect(refreshed.resolvedFileName).toBeUndefined();
    expect(refreshed.projectorCandidates).toBeUndefined();
    expect(refreshed.selectedProjectorId).toBeUndefined();
    expect(refreshed.multimodalReadiness).toBeUndefined();
    expect(refreshed.artifacts?.some((artifact) => artifact.kind === 'multimodal_projector')).not.toBe(true);
    expect(refreshed.chatModalities).toEqual(['text']);
    expect(refreshed.chatModalities).not.toContain('audio');
    expect(refreshed.chatModalities).not.toContain('vision');
    expect(refreshed.inputCapabilities?.declared.audio).toBe('supported');
    expect(nativeSupport).toEqual({ vision: false, audio: false });
  });

  it('replaces stale local registry state after a final projector-only tree probe miss', async () => {
    const modelId = 'test-org/projector-only-local-registry';
    const { localModel } = makeDownloadedVisionModelWithProjector({ modelId });
    const staleLocalModel: ModelMetadata = {
      ...localModel,
      requiresTreeProbe: true,
      visionSource: 'catalog_metadata',
      visionConfidence: 'inferred',
    };
    let registryModel: ModelMetadata | undefined = staleLocalModel;
    mockedRegistry.getModel.mockImplementation((id: string) => (id === modelId ? registryModel : undefined));
    mockedRegistry.updateModel.mockImplementation((model: ModelMetadata) => {
      registryModel = model;
    });

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
          {
            path: 'mmproj-model-f16.gguf',
            size: 1024,
            lfs: { sha256: PROJECTOR_SHA256 },
          },
        ]),
      });
    }) as jest.Mock;

    const refreshed = await service.refreshModelMetadata(staleLocalModel, { includeDetails: false });

    expect(mockedRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      id: modelId,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: false,
    }));
    expect(registryModel).toEqual(expect.objectContaining({
      id: modelId,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      requiresTreeProbe: false,
    }));
    expect(registryModel?.localPath).toBeUndefined();
    expect(registryModel?.downloadedAt).toBeUndefined();
    expect(registryModel?.downloadIntegrity).toBeUndefined();
    expect(registryModel?.projectorCandidates).toBeUndefined();
    expect(registryModel?.selectedProjectorId).toBeUndefined();
    expect(registryModel?.multimodalReadiness).toBeUndefined();
    expect(registryModel?.chatModalities).not.toContain('vision');
    expect(refreshed).toEqual(registryModel);
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

  it('clears effective audio and audio projector metadata after an authoritative empty tree result', async () => {
    const modelId = 'org/complete-zero-audio-projector-clear';
    const modelFileName = 'audio-model.Q4_K_M.gguf';
    const { localModel: audioLocalModel, localProjector } = makeDownloadedAudioModelWithProjector({
      modelId,
      modelFileName,
    });
    const localModel: ModelMetadata = {
      ...audioLocalModel,
      hasVerifiedContextWindow: true,
      chatModalities: ['text', 'vision', 'audio'],
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      artifacts: audioLocalModel.artifacts?.map((artifact) => (
        artifact.kind === 'multimodal_projector'
          ? { ...artifact, requiredFor: ['image' as const, 'audio' as const] }
          : artifact
      )),
      multimodalReadiness: {
        modelId,
        variantId: modelFileName,
        status: 'ready',
        projectorId: localProjector.id,
        support: ['vision', 'audio'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1234,
      },
    };

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/tree/main?recursive=true')) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        json: () => Promise.resolve([
          { path: modelFileName, size: localModel.size, lfs: { sha256: TREE_SHA256 } },
        ]),
      });
    }) as jest.Mock;
    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    const refreshed = await service.refreshModelMetadata(localModel, { includeDetails: true });
    const projectorArtifacts = refreshed.artifacts?.filter((artifact) => (
      artifact.kind === 'multimodal_projector'
    ));

    expect(refreshed.inputCapabilities?.declared.audio).toBe('supported');
    expect(refreshed.chatModalities).toEqual(['text', 'vision']);
    expect(refreshed.projectorCandidates).toBeUndefined();
    expect(refreshed.selectedProjectorId).toBeUndefined();
    expect(refreshed.multimodalReadiness).toBeUndefined();
    expect(projectorArtifacts?.map((artifact) => artifact.requiredFor)).toEqual([['image']]);
    expect(refreshed.visionSource).toBe('catalog_metadata');
    expect(refreshed.visionConfidence).toBe('trusted');
    expect(resolveEffectiveActiveVariantNativeSupport(refreshed)).toEqual({
      vision: true,
      audio: false,
    });
    expect(resolveComposerNativeInputs(refreshed)).toEqual({ image: false, audio: false });
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
          requestedSupport: ['vision'],
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

  it.each([
    { remoteOwnerVariantId: 'audio-q4', localOwnerVariantId: 'audio.Q4.gguf' },
    { remoteOwnerVariantId: 'audio.Q4.gguf', localOwnerVariantId: 'audio-q4' },
  ])('merges projector runtime state across active variant id/file aliases: $remoteOwnerVariantId', ({
    remoteOwnerVariantId,
    localOwnerVariantId,
  }) => {
    const modelId = 'org/projector-alias-merge';
    const { localModel: baseModel, localProjector: baseProjector } = makeDownloadedAudioModelWithProjector({ modelId });
    const localProjector = { ...baseProjector, ownerVariantId: localOwnerVariantId };
    const remoteProjector = {
      ...baseProjector,
      ownerVariantId: remoteOwnerVariantId,
      localPath: undefined,
      lifecycleStatus: 'available' as const,
    };
    const variant = {
      variantId: 'audio-q4',
      fileName: 'audio.Q4.gguf',
      quantizationLabel: 'Q4_K_M',
      size: baseModel.size,
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
    };
    const remoteModel: ModelMetadata = {
      ...baseModel,
      activeVariantId: variant.variantId,
      resolvedFileName: variant.fileName,
      variants: [{ ...variant, projectorCandidates: [remoteProjector] }],
      projectorCandidates: [remoteProjector],
      selectedProjectorId: remoteProjector.id,
    };
    const localModel: ModelMetadata = {
      ...baseModel,
      activeVariantId: variant.variantId,
      resolvedFileName: variant.fileName,
      variants: [{ ...variant, projectorCandidates: [localProjector] }],
      projectorCandidates: [localProjector],
      selectedProjectorId: localProjector.id,
    };
    const mergeProjectorMetadata = (service as unknown as {
      mergeProjectorMetadataWithLocalState: (
        remote: ModelMetadata,
        local: ModelMetadata,
        reset: boolean,
      ) => {
        projectorCandidates?: ProjectorArtifact[];
        selectedProjectorId?: string;
      };
    }).mergeProjectorMetadataWithLocalState.bind(service);

    const merged = mergeProjectorMetadata(remoteModel, localModel, false);

    expect(merged.projectorCandidates).toEqual([
      expect.objectContaining({
        id: remoteProjector.id,
        localPath: localProjector.localPath,
        lifecycleStatus: 'downloaded',
      }),
    ]);
    expect(merged.selectedProjectorId).toBe(remoteProjector.id);
  });

  it('preserves remote and local variant-only projector candidates and selections', () => {
    const modelId = 'org/variant-only-projector-merge';
    const { localModel: baseModel, localProjector: baseProjector, modelFileName } = makeDownloadedAudioModelWithProjector({ modelId });
    const projector = { ...baseProjector, ownerVariantId: 'audio-q4' };
    const variantBase = {
      variantId: 'audio-q4',
      fileName: modelFileName,
      quantizationLabel: 'Q4_K_M',
      size: baseModel.size,
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
    };
    const withoutProjector: ModelMetadata = {
      ...baseModel,
      activeVariantId: variantBase.variantId,
      variants: [variantBase],
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
    };
    const withVariantProjector: ModelMetadata = {
      ...withoutProjector,
      variants: [{
        ...variantBase,
        projectorCandidates: [projector],
        selectedProjectorId: projector.id,
      }],
      multimodalReadiness: {
        modelId,
        variantId: variantBase.variantId,
        status: 'ready',
        projectorId: projector.id,
        support: ['audio'],
        requestedSupport: ['audio'],
        checkedAt: 1,
      },
    };
    const mergeProjectorMetadata = (service as unknown as {
      mergeProjectorMetadataWithLocalState: (
        remote: ModelMetadata,
        local: ModelMetadata,
        reset: boolean,
      ) => {
        projectorCandidates?: ProjectorArtifact[];
        selectedProjectorId?: string;
        multimodalReadiness?: ModelMetadata['multimodalReadiness'];
      };
    }).mergeProjectorMetadataWithLocalState.bind(service);

    const remoteVariantOnly = mergeProjectorMetadata(withVariantProjector, withoutProjector, false);
    const localVariantOnly = mergeProjectorMetadata(withoutProjector, withVariantProjector, false);

    for (const merged of [remoteVariantOnly, localVariantOnly]) {
      expect(merged.projectorCandidates).toEqual([
        expect.objectContaining({ id: projector.id }),
      ]);
      expect(merged.selectedProjectorId).toBe(projector.id);
    }
    expect(localVariantOnly.multimodalReadiness).toEqual(expect.objectContaining({
      projectorId: projector.id,
      requestedSupport: ['audio'],
    }));
  });

  it('preserves downloaded local audio metadata when remote catalog is explicit text-only', () => {
    const modelId = 'org/local-runtime-audio';
    const { localModel, localProjector } = makeDownloadedAudioModelWithProjector({ modelId });
    const remoteModel: ModelMetadata = {
      ...localModel,
      name: 'Local Runtime Audio Remote',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text'],
      inputCapabilities: undefined,
      artifacts: undefined,
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
    };
    const mergeModelWithRegistry = (service as unknown as {
      mergeModelWithRegistry: (
        remoteModel: ModelMetadata,
        memoryFitContext: { totalMemoryBytes: number; systemMemorySnapshot: null },
      ) => ModelMetadata | undefined;
    }).mergeModelWithRegistry.bind(service);

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    const merged = mergeModelWithRegistry(remoteModel, {
      totalMemoryBytes: 4 * 1024 * 1024 * 1024,
      systemMemorySnapshot: null,
    });

    expect(merged?.chatModalities).toEqual(['text', 'audio']);
    expect(merged?.artifactRole).toBe('primary_chat_model');
    expect(merged?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: localProjector.id,
      localPath: localProjector.localPath,
      lifecycleStatus: 'downloaded',
    }));
    expect(merged?.selectedProjectorId).toBe(localProjector.id);
    expect(merged?.multimodalReadiness).toEqual(expect.objectContaining({
      projectorId: localProjector.id,
      support: ['audio'],
      requestedSupport: ['audio'],
    }));
    expect(resolveModelNativeMultimodalSupport(merged!)).toEqual({ vision: false, audio: true });
  });

  it('drops local audio metadata when remote catalog identity resets local download state', () => {
    const modelId = 'org/reset-local-audio';
    const { localModel } = makeDownloadedAudioModelWithProjector({ modelId });
    const remoteModel: ModelMetadata = {
      ...localModel,
      name: 'Reset Local Audio Remote',
      size: localModel.size! + 1024,
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text'],
      inputCapabilities: undefined,
      artifacts: undefined,
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
    };
    const mergeModelWithRegistry = (service as unknown as {
      mergeModelWithRegistry: (
        remoteModel: ModelMetadata,
        memoryFitContext: { totalMemoryBytes: number; systemMemorySnapshot: null },
      ) => ModelMetadata | undefined;
    }).mergeModelWithRegistry.bind(service);

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    const merged = mergeModelWithRegistry(remoteModel, {
      totalMemoryBytes: 4 * 1024 * 1024 * 1024,
      systemMemorySnapshot: null,
    });

    expect(merged?.chatModalities).toEqual(['text']);
    expect(merged?.projectorCandidates).toBeUndefined();
    expect(merged?.selectedProjectorId).toBeUndefined();
    expect(merged?.multimodalReadiness).toBeUndefined();
    expect(merged?.localPath).toBeUndefined();
    expect(merged?.downloadedAt).toBeUndefined();
    expect(merged?.lifecycleStatus).toBe(LifecycleStatus.AVAILABLE);
    expect(resolveModelNativeMultimodalSupport(merged!)).toEqual({ vision: false, audio: false });
  });

  it.each([
    { name: 'bare explicit audio without a runtime path', state: 'bare', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'missing-projector requested audio', state: 'missing', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'ready audio with a compatible candidate', state: 'ready', preservesAudio: true, keepsReadiness: true, keepsSelection: false },
    { name: 'ready audio with stale local vision provenance', state: 'ready_stale_vision', preservesAudio: true, keepsReadiness: true, keepsSelection: false },
    { name: 'ready audio with empty support', state: 'ready_empty', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'ready audio with the wrong requested support', state: 'wrong_requested', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'ready audio from the wrong variant', state: 'wrong_variant', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'failed audio readiness without another runtime path', state: 'failed', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'an installed matching audio artifact', state: 'artifact', preservesAudio: true, keepsReadiness: false, keepsSelection: false },
    { name: 'an installed matching audio artifact with a normalized filename alias', state: 'artifact_normalized_filename', preservesAudio: true, keepsReadiness: false, keepsSelection: false },
    { name: 'an installed audio artifact without a local path', state: 'artifact_missing_path', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'a selected downloaded audio projector', state: 'selected', preservesAudio: true, keepsReadiness: false, keepsSelection: true },
    { name: 'a selected downloaded projector with only declared audio evidence', state: 'selected_declared_only', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'an installed audio artifact with a conflicting candidate id', state: 'artifact_conflict', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'an installed audio artifact with conflicting candidate metadata', state: 'artifact_metadata_conflict', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
    { name: 'an exact installed audio artifact plus a conflicting duplicate identity', state: 'artifact_mixed_conflict', preservesAudio: false, keepsReadiness: false, keepsSelection: false },
  ])('applies trusted local audio runtime rules for $name', ({
    state,
    preservesAudio,
    keepsReadiness,
    keepsSelection,
  }) => {
    const modelId = `org/audio-runtime-matrix-${state}`;
    const { localModel: baseLocalModel, localProjector, modelFileName } = makeDownloadedAudioModelWithProjector({
      modelId,
      projectorSha256: PROJECTOR_SHA256,
    });
    const availableProjector: ProjectorArtifact = {
      ...localProjector,
      localPath: undefined,
      lifecycleStatus: 'available',
    };
    let localModel: ModelMetadata = {
      ...baseLocalModel,
      artifacts: undefined,
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
    };

    if (state === 'missing') {
      localModel = {
        ...localModel,
        multimodalReadiness: {
          modelId,
          variantId: modelFileName,
          status: 'missing_projector',
          support: [],
          requestedSupport: ['audio'],
          checkedAt: 1234,
        },
      };
    } else if (['ready', 'ready_stale_vision', 'ready_empty', 'wrong_requested', 'wrong_variant', 'failed'].includes(state)) {
      localModel = {
        ...localModel,
        ...(state === 'ready_stale_vision'
          ? { visionSource: 'gguf_metadata' as const, visionConfidence: 'verified' as const }
          : {}),
        projectorCandidates: [availableProjector],
        multimodalReadiness: {
          modelId,
          variantId: state === 'wrong_variant' ? 'other-variant.gguf' : modelFileName,
          status: state === 'failed' ? 'failed' : 'ready',
          projectorId: availableProjector.id,
          support: state === 'ready_empty' ? [] : ['audio'],
          requestedSupport: state === 'wrong_requested' ? ['vision'] : ['audio'],
          checkedAt: 1234,
        },
      };
    } else if (state === 'artifact' || state === 'artifact_normalized_filename') {
      localModel = {
        ...localModel,
        artifacts: state === 'artifact_normalized_filename'
          ? baseLocalModel.artifacts?.map((artifact) => (
            artifact.kind === 'multimodal_projector'
              ? {
                  ...artifact,
                  hfRevision: ' main ',
                  remoteFileName: `nested/${artifact.remoteFileName.toUpperCase()}`,
                }
              : artifact
          ))
          : baseLocalModel.artifacts,
        projectorCandidates: [localProjector],
      };
    } else if (state === 'artifact_missing_path') {
      localModel = {
        ...localModel,
        artifacts: baseLocalModel.artifacts?.map((artifact) => (
          artifact.kind === 'multimodal_projector'
            ? { ...artifact, localPath: undefined }
            : artifact
        )),
        projectorCandidates: [availableProjector],
      };
    } else if (state === 'selected' || state === 'selected_declared_only') {
      localModel = {
        ...localModel,
        ...(state === 'selected_declared_only' ? { chatModalities: undefined } : {}),
        projectorCandidates: [localProjector],
        selectedProjectorId: localProjector.id,
      };
    } else if (state === 'artifact_conflict') {
      const conflictingArtifactId = `${localProjector.id}-conflict`;
      localModel = {
        ...localModel,
        artifacts: baseLocalModel.artifacts?.map((artifact) => (
          artifact.kind === 'multimodal_projector'
            ? { ...artifact, id: conflictingArtifactId }
            : artifact
        )),
        projectorCandidates: [localProjector],
      };
    } else if (state === 'artifact_metadata_conflict') {
      localModel = {
        ...localModel,
        artifacts: baseLocalModel.artifacts,
        projectorCandidates: [{ ...localProjector, sha256: DIFFERENT_PROJECTOR_SHA256 }],
      };
    } else if (state === 'artifact_mixed_conflict') {
      const exactProjectorArtifact = baseLocalModel.artifacts?.find((artifact) => (
        artifact.kind === 'multimodal_projector'
      ));
      localModel = {
        ...localModel,
        artifacts: exactProjectorArtifact
          ? [
              exactProjectorArtifact,
              {
                ...exactProjectorArtifact,
                remoteFileName: `conflicting-${exactProjectorArtifact.remoteFileName}`,
                downloadUrl: `https://example.com/conflicting-${exactProjectorArtifact.remoteFileName}`,
              },
            ]
          : undefined,
        projectorCandidates: [localProjector],
      };
    }

    const remoteModel: ModelMetadata = {
      ...localModel,
      name: `Remote ${state}`,
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text'],
      inputCapabilities: undefined,
      artifacts: undefined,
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
      visionSource: undefined,
      visionConfidence: undefined,
    };
    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    const merged = mergeModelWithRegistryForTest(service, remoteModel);
    expect(merged).toBeDefined();
    const projectorArtifacts = merged!.artifacts?.filter((artifact) => (
      artifact.kind === 'multimodal_projector'
    )) ?? [];

    expect(merged!.chatModalities).toEqual(preservesAudio ? ['text', 'audio'] : ['text']);
    expect(merged!.projectorCandidates ?? []).toHaveLength(preservesAudio ? 1 : 0);
    expect(merged!.selectedProjectorId).toBe(keepsSelection ? localProjector.id : undefined);
    expect(Boolean(merged!.multimodalReadiness)).toBe(keepsReadiness);
    expect(merged!.visionSource).toBeUndefined();
    expect(merged!.visionConfidence).toBeUndefined();
    expect(projectorArtifacts.map((artifact) => artifact.requiredFor)).toEqual(
      preservesAudio ? [['audio']] : [],
    );
    expect(resolveEffectiveActiveVariantNativeSupport(merged!)).toEqual({
      vision: false,
      audio: preservesAudio,
    });
    expect(resolveComposerNativeInputs(merged!)).toEqual({
      image: false,
      audio: keepsReadiness,
    });
  });

  it.each([
    { state: 'selected', keepsAudio: true },
    { state: 'bare', keepsAudio: false },
  ])('handles stale top-level vision with an explicit active audio variant and $state runtime path', ({
    state,
    keepsAudio,
  }) => {
    const modelId = `org/active-audio-stale-top-${state}`;
    const { localModel: baseModel, localProjector, modelFileName } = makeDownloadedAudioModelWithProjector({ modelId });
    const scopedProjector = { ...localProjector, ownerVariantId: 'audio-q4' };
    const activeVariant = {
      variantId: 'audio-q4',
      fileName: modelFileName,
      quantizationLabel: 'Q4_K_M',
      size: baseModel.size,
      chatModalities: ['text', 'audio'] as Array<'text' | 'audio'>,
      visionSource: 'gguf_metadata' as const,
      visionConfidence: 'verified' as const,
      ...(keepsAudio ? {
        projectorCandidates: [scopedProjector],
        selectedProjectorId: scopedProjector.id,
      } : {}),
    };
    const localModel: ModelMetadata = {
      ...baseModel,
      chatModalities: ['text', 'vision'],
      activeVariantId: activeVariant.variantId,
      resolvedFileName: activeVariant.fileName,
      variants: [activeVariant],
      artifacts: undefined,
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
    };
    const remoteModel: ModelMetadata = {
      ...localModel,
      name: `Remote ${state}`,
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text'],
      variants: [{
        ...activeVariant,
        projectorCandidates: undefined,
        selectedProjectorId: undefined,
      }],
    };
    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    const merged = mergeModelWithRegistryForTest(service, remoteModel);

    expect(merged).toBeDefined();
    expect(merged!.projectorCandidates ?? []).toHaveLength(keepsAudio ? 1 : 0);
    expect(merged!.selectedProjectorId).toBe(keepsAudio ? scopedProjector.id : undefined);
    expect(merged!.visionSource).toBeUndefined();
    expect(merged!.visionConfidence).toBeUndefined();
    const mergedActiveVariant = merged!.variants?.find((variant) => (
      variant.variantId === activeVariant.variantId
    ));
    expect(mergedActiveVariant?.visionSource).toBeUndefined();
    expect(mergedActiveVariant?.visionConfidence).toBeUndefined();
    expect(resolveEffectiveActiveVariantNativeSupport(merged!)).toEqual({
      vision: false,
      audio: keepsAudio,
    });
  });

  it('preserves trusted active-variant vision when the parent modality baseline is text-only', () => {
    const modelId = 'org/active-vision-stale-top';
    const { localModel: baseModel, localProjector, modelFileName } = makeDownloadedVisionModelWithProjector({ modelId });
    const scopedProjector = { ...localProjector, ownerVariantId: 'vision-q4' };
    const localModel: ModelMetadata = {
      ...baseModel,
      chatModalities: ['text'],
      visionSource: 'gguf_metadata',
      visionConfidence: 'verified',
      activeVariantId: 'vision-q4',
      resolvedFileName: modelFileName,
      variants: [{
        variantId: 'vision-q4',
        fileName: modelFileName,
        quantizationLabel: 'Q4_K_M',
        size: baseModel.size,
        chatModalities: ['text', 'vision'],
        projectorCandidates: [scopedProjector],
        selectedProjectorId: scopedProjector.id,
      }],
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
    };
    const remoteModel: ModelMetadata = {
      ...localModel,
      name: 'Remote active vision',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      visionSource: undefined,
      visionConfidence: undefined,
      multimodalReadiness: undefined,
      variants: [{
        variantId: 'vision-q4',
        fileName: modelFileName,
        quantizationLabel: 'Q4_K_M',
        size: baseModel.size,
      }, {
        variantId: 'text-q8',
        fileName: 'model.Q8_0.gguf',
        quantizationLabel: 'Q8_0',
        size: baseModel.size,
        chatModalities: ['text'],
      }],
    };
    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    const merged = mergeModelWithRegistryForTest(service, remoteModel);

    expect(merged).toBeDefined();
    expect(merged!.chatModalities).toEqual(['text']);
    expect(merged!.variants?.find((variant) => variant.variantId === 'vision-q4')?.chatModalities)
      .toEqual(['text', 'vision']);
    expect(merged!.projectorCandidates).toEqual([
      expect.objectContaining({
        id: scopedProjector.id,
        localPath: scopedProjector.localPath,
      }),
    ]);
    expect(merged!.visionSource).toBe('gguf_metadata');
    expect(resolveEffectiveActiveVariantNativeSupport(merged!)).toEqual({
      vision: true,
      audio: false,
    });
    expect(resolveEffectiveActiveVariantNativeSupport(
      applyModelVariantSelection(merged!, 'text-q8'),
    )).toEqual({ vision: false, audio: false });
  });

  it('preserves a local active text-only clamp without contaminating a sibling fallback variant', () => {
    const modelId = 'org/active-text-clamp';
    const { localModel: baseModel, modelFileName } = makeDownloadedVisionModelWithProjector({ modelId });
    const remoteVariants = [{
      variantId: 'text-q4',
      fileName: modelFileName,
      quantizationLabel: 'Q4_K_M',
      size: baseModel.size,
    }, {
      variantId: 'fallback-q8',
      fileName: 'model.Q8_0.gguf',
      quantizationLabel: 'Q8_0',
      size: baseModel.size,
    }];
    const localModel: ModelMetadata = {
      ...baseModel,
      activeVariantId: 'text-q4',
      resolvedFileName: modelFileName,
      variants: [{
        ...remoteVariants[0],
        chatModalities: ['text'],
      }],
      artifacts: undefined,
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
    };
    const remoteModel: ModelMetadata = {
      ...localModel,
      name: 'Remote active text clamp',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text', 'vision'],
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      variants: remoteVariants,
    };
    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    const merged = mergeModelWithRegistryForTest(service, remoteModel);

    expect(merged).toBeDefined();
    expect(merged!.variants?.find((variant) => variant.variantId === 'text-q4')?.chatModalities)
      .toEqual(['text']);
    expect(resolveEffectiveActiveVariantNativeSupport(merged!)).toEqual({
      vision: false,
      audio: false,
    });
    const siblingSelected = applyModelVariantSelection(merged!, 'fallback-q8');
    expect(siblingSelected.variants?.find((variant) => variant.variantId === 'fallback-q8')?.chatModalities)
      .toBeUndefined();
    expect(resolveEffectiveActiveVariantNativeSupport(siblingSelected)).toEqual({
      vision: true,
      audio: false,
    });
  });

  it.each([
    { remoteModality: 'audio', localModality: 'vision' },
    { remoteModality: 'vision', localModality: 'audio' },
  ] as const)(
    'keeps an explicit remote active $remoteModality variant authoritative over stale local $localModality metadata',
    ({ remoteModality, localModality }) => {
      const modelId = `org/active-variant-remote-${remoteModality}-local-${localModality}`;
      const modelFileName = 'model.Q4_K_M.gguf';
      const localFixture = localModality === 'audio'
        ? makeDownloadedAudioModelWithProjector({ modelId, modelFileName })
        : makeDownloadedVisionModelWithProjector({ modelId, modelFileName });
      const remoteFixture = remoteModality === 'audio'
        ? makeDownloadedAudioModelWithProjector({
          modelId,
          modelFileName,
          projectorFileName: 'mmproj-remote-audio.gguf',
        })
        : makeDownloadedVisionModelWithProjector({
          modelId,
          modelFileName,
          projectorFileName: 'mmproj-remote-vision.gguf',
        });
      const localProjector = {
        ...localFixture.localProjector,
        ownerVariantId: 'q4',
      };
      const remoteProjector = {
        ...remoteFixture.localProjector,
        ownerVariantId: 'q4',
        localPath: undefined,
        lifecycleStatus: 'available' as const,
      };
      const localModel: ModelMetadata = {
        ...localFixture.localModel,
        activeVariantId: 'q4',
        resolvedFileName: modelFileName,
        projectorCandidates: undefined,
        selectedProjectorId: undefined,
        variants: [{
          variantId: 'q4',
          fileName: modelFileName,
          quantizationLabel: 'Q4_K_M',
          size: localFixture.localModel.size,
          isLocal: true,
          chatModalities: ['text', localModality],
          projectorCandidates: [localProjector],
          selectedProjectorId: localProjector.id,
          ...(localModality === 'vision' ? {
            visionSource: 'gguf_metadata' as const,
            visionConfidence: 'verified' as const,
          } : {}),
        }],
      };
      const remoteModel: ModelMetadata = {
        ...remoteFixture.localModel,
        name: `Remote ${remoteModality}`,
        activeVariantId: 'q4',
        resolvedFileName: modelFileName,
        localPath: undefined,
        downloadedAt: undefined,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        chatModalities: ['text', remoteModality],
        projectorCandidates: undefined,
        selectedProjectorId: undefined,
        multimodalReadiness: undefined,
        variants: [{
          variantId: 'q4',
          fileName: modelFileName,
          quantizationLabel: 'Q4_K_M',
          size: remoteFixture.localModel.size,
          chatModalities: ['text', remoteModality],
          projectorCandidates: [remoteProjector],
          selectedProjectorId: remoteProjector.id,
          ...(remoteModality === 'vision' ? {
            visionSource: 'catalog_metadata' as const,
            visionConfidence: 'trusted' as const,
          } : {}),
        }],
      };
      mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

      const merged = mergeModelWithRegistryForTest(service, remoteModel);

      expect(merged?.variants?.find((variant) => variant.variantId === 'q4')?.chatModalities)
        .toEqual(['text', remoteModality]);
      expect(resolveEffectiveActiveVariantNativeSupport(merged!)).toEqual({
        vision: remoteModality === 'vision',
        audio: remoteModality === 'audio',
      });
      expect([
        ...(merged?.projectorCandidates ?? []),
        ...(merged?.variants?.flatMap((variant) => variant.projectorCandidates ?? []) ?? []),
      ].some((projector) => projector.id === localProjector.id)).toBe(false);
    },
  );

  it.each([
    { remoteModality: 'audio', localModality: 'vision', preservesProjector: false },
    { remoteModality: 'audio', localModality: 'audio', preservesProjector: true },
    { remoteModality: 'vision', localModality: 'audio', preservesProjector: false },
    { remoteModality: 'vision', localModality: 'vision', preservesProjector: true },
  ] as const)(
    'filters $localModality-only local projector metadata from a $remoteModality-only catalog scope',
    ({ remoteModality, localModality, preservesProjector }) => {
      const modelId = `org/projector-modality-matrix-${remoteModality}-${localModality}`;
      const localFixture = localModality === 'audio'
        ? makeDownloadedAudioModelWithProjector({ modelId })
        : makeDownloadedVisionModelWithProjector({ modelId });
      const localModel: ModelMetadata = localModality === 'vision'
        ? {
          ...localFixture.localModel,
          visionSource: 'gguf_metadata',
          visionConfidence: 'verified',
        }
        : localFixture.localModel;
      const remoteModel: ModelMetadata = {
        ...localModel,
        name: `Remote ${remoteModality}`,
        localPath: undefined,
        downloadedAt: undefined,
        lifecycleStatus: LifecycleStatus.AVAILABLE,
        downloadProgress: 0,
        chatModalities: ['text', remoteModality],
        inputCapabilities: undefined,
        artifacts: undefined,
        projectorCandidates: undefined,
        selectedProjectorId: undefined,
        multimodalReadiness: undefined,
        visionSource: remoteModality === 'vision' ? 'catalog_metadata' : undefined,
        visionConfidence: remoteModality === 'vision' ? 'trusted' : undefined,
      };
      mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

      const merged = mergeModelWithRegistryForTest(service, remoteModel);
      expect(merged).toBeDefined();
      const expectedSupport = {
        vision: remoteModality === 'vision',
        audio: remoteModality === 'audio' && preservesProjector,
      };
      const projectorArtifacts = merged!.artifacts?.filter((artifact) => (
        artifact.kind === 'multimodal_projector'
      )) ?? [];

      expect(merged!.chatModalities).toEqual(['text', remoteModality]);
      expect(merged!.projectorCandidates ?? []).toHaveLength(preservesProjector ? 1 : 0);
      expect(merged!.selectedProjectorId).toBe(
        preservesProjector ? localFixture.localProjector.id : undefined,
      );
      expect(Boolean(merged!.multimodalReadiness)).toBe(preservesProjector);
      expect(projectorArtifacts.map((artifact) => artifact.requiredFor)).toEqual(
        preservesProjector
          ? [[remoteModality === 'vision' ? 'image' : 'audio']]
          : [],
      );
      expect(resolveEffectiveActiveVariantNativeSupport(merged!)).toEqual(expectedSupport);
      expect(resolveComposerNativeInputs(merged!)).toEqual({
        image: preservesProjector && remoteModality === 'vision',
        audio: preservesProjector && remoteModality === 'audio',
      });
      if (remoteModality === 'audio') {
        expect(merged!.visionSource).toBeUndefined();
        expect(merged!.visionConfidence).toBeUndefined();
      }
    },
  );

  it('drops stale vision readiness and provenance when remote catalog is explicit audio-only', () => {
    const modelId = 'org/local-mixed-remote-audio';
    const { localModel, localProjector } = makeDownloadedAudioModelWithProjector({ modelId });
    const mixedLocalModel: ModelMetadata = {
      ...localModel,
      chatModalities: ['text', 'vision', 'audio'],
      visionSource: 'gguf_metadata',
      visionConfidence: 'verified',
      artifacts: localModel.artifacts?.map((artifact) => (
        artifact.kind === 'multimodal_projector'
          ? { ...artifact, requiredFor: ['image' as const, 'audio' as const] }
          : artifact
      )),
      multimodalReadiness: {
        modelId,
        variantId: localModel.resolvedFileName,
        status: 'ready',
        projectorId: localProjector.id,
        support: ['vision', 'audio'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1234,
      },
    };
    const remoteModel: ModelMetadata = {
      ...mixedLocalModel,
      name: 'Remote Audio Only',
      localPath: undefined,
      downloadedAt: undefined,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text', 'audio'],
      artifacts: undefined,
      projectorCandidates: undefined,
      selectedProjectorId: undefined,
      multimodalReadiness: undefined,
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
    };
    const mergeModelWithRegistry = (service as unknown as {
      mergeModelWithRegistry: (
        remoteModel: ModelMetadata,
        memoryFitContext: { totalMemoryBytes: number; systemMemorySnapshot: null },
      ) => ModelMetadata | undefined;
    }).mergeModelWithRegistry.bind(service);

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? mixedLocalModel : undefined));

    const merged = mergeModelWithRegistry(remoteModel, {
      totalMemoryBytes: 4 * 1024 * 1024 * 1024,
      systemMemorySnapshot: null,
    });

    expect(merged?.chatModalities).toEqual(['text', 'audio']);
    expect(merged?.visionSource).toBeUndefined();
    expect(merged?.visionConfidence).toBeUndefined();
    expect(merged?.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: localProjector.id,
      localPath: localProjector.localPath,
      lifecycleStatus: 'downloaded',
    }));
    expect(merged?.multimodalReadiness).toBeUndefined();
    expect(resolveModelNativeMultimodalSupport(merged!)).toEqual({ vision: false, audio: true });
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

  it('uses active variant-compatible projector size when catalog registry merge recomputes memory fit', () => {
    const modelId = 'org/active-variant-projector-memory-rv07';
    const defaultModelFileName = 'model.Q4_K_M.gguf';
    const activeModelFileName = 'model.Q8_0.gguf';
    const activeVariantId = 'active-q8';
    const staleActiveVariantId = 'stale-active-id';
    const defaultProjectorFileName = 'mmproj-default-f16.gguf';
    const activeProjectorFileName = 'mmproj-active-f16.gguf';
    const baseSizeBytes = 1 * 1024 * 1024 * 1024;
    const inactiveProjectorSizeBytes = 4 * 1024 * 1024 * 1024;
    const activeProjectorSizeBytes = 512 * 1024 * 1024;
    const inactiveProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: defaultModelFileName,
      fileName: defaultProjectorFileName,
    });
    const activeProjectorId = buildProjectorArtifactId({
      repoId: modelId,
      hfRevision: 'main',
      ownerVariantId: activeModelFileName,
      fileName: activeProjectorFileName,
    });
    const inactiveProjector: ProjectorArtifact = {
      id: inactiveProjectorId,
      ownerModelId: modelId,
      ownerVariantId: staleActiveVariantId,
      repoId: modelId,
      fileName: defaultProjectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${defaultProjectorFileName}`,
      hfRevision: 'main',
      size: inactiveProjectorSizeBytes,
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    };
    const activeProjector: ProjectorArtifact = {
      id: activeProjectorId,
      ownerModelId: modelId,
      ownerVariantId: activeVariantId,
      repoId: modelId,
      fileName: activeProjectorFileName,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${activeProjectorFileName}`,
      hfRevision: 'main',
      size: activeProjectorSizeBytes,
      lifecycleStatus: 'available',
      matchStatus: 'matched',
    };
    const remoteModel: ModelMetadata = {
      id: modelId,
      name: 'Active Variant Projector Memory RV07',
      author: 'org',
      size: baseSizeBytes,
      downloadUrl: `https://huggingface.co/${modelId}/resolve/main/${activeModelFileName}`,
      hfRevision: 'main',
      resolvedFileName: activeModelFileName,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      metadataTrust: 'trusted_remote',
      activeVariantId: staleActiveVariantId,
      variants: [
        {
          variantId: defaultModelFileName,
          fileName: defaultModelFileName,
          quantizationLabel: 'Q4_K_M',
          size: baseSizeBytes,
        },
        {
          variantId: activeVariantId,
          fileName: activeModelFileName,
          quantizationLabel: 'Q8_0',
          size: baseSizeBytes,
        },
      ],
      chatModalities: ['text', 'vision'],
      projectorCandidates: [inactiveProjector, activeProjector],
      selectedProjectorId: inactiveProjector.id,
    };
    const localModel: ModelMetadata = {
      ...remoteModel,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      localPath: activeModelFileName,
      downloadedAt: 1234,
    };
    const mergeModelWithRegistry = (service as unknown as {
      mergeModelWithRegistry: (
        remoteModel: ModelMetadata,
        memoryFitContext: { totalMemoryBytes: number; systemMemorySnapshot: null },
      ) => ModelMetadata | undefined;
    }).mergeModelWithRegistry.bind(service);

    mockedRegistry.getModel.mockImplementation((id) => (id === modelId ? localModel : undefined));

    const merged = mergeModelWithRegistry(remoteModel, {
      totalMemoryBytes: 4 * 1024 * 1024 * 1024,
      systemMemorySnapshot: null,
    });

    expect(merged).toEqual(expect.objectContaining({
      id: modelId,
      fitsInRam: true,
    }));
    expect(merged?.memoryFitDecision).not.toBe('likely_oom');
    expect(merged?.variants?.find((variant) => variant.fileName === activeModelFileName)?.ramFit)
      .not.toBe('likely_oom');
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
