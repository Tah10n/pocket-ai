import {
  LifecycleStatus,
  ModelAccessState,
  type ModelArtifactMetadata,
  type ModelMetadata,
} from '../../src/types/models';
import {
  buildMainModelArtifactId,
  deriveArtifactsFromLegacyModel,
  getInstalledArtifactLocalPaths,
  getRequiredDownloadArtifacts,
  getSelectedProjectorArtifact,
  getTotalInstalledModelBytes,
  isMainArtifactReady,
  isMultimodalArtifactReady,
  normalizePersistedModelArtifacts,
  syncLegacyMainArtifactFields,
} from '../../src/utils/modelArtifacts';

function makeModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'test-org/model',
    name: 'model',
    author: 'test-org',
    size: 1_000,
    downloadUrl: 'https://huggingface.co/test-org/model/resolve/main/model.Q4_K_M.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    ...overrides,
  };
}

describe('modelArtifacts', () => {
  it('derives a remote main artifact and projector artifacts from catalog metadata', () => {
    const artifacts = deriveArtifactsFromLegacyModel(makeModel({
      hfRevision: 'abc123',
      resolvedFileName: 'model.Q4_K_M.gguf',
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'test-org/model',
          repoId: 'test-org/model',
          fileName: 'mmproj-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/test-org/model/resolve/main/mmproj-model-f16.gguf',
          hfRevision: 'abc123',
          size: 500,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
      ],
    }), { includeRemoteMain: true });

    expect(artifacts).toEqual([
      expect.objectContaining({
        kind: 'main_model',
        requiredFor: ['text'],
        remoteFileName: 'model.Q4_K_M.gguf',
        installState: 'remote',
        sizeBytes: 1_000,
      }),
      expect.objectContaining({
        id: 'projector-a',
        kind: 'multimodal_projector',
        requiredFor: ['image'],
        remoteFileName: 'mmproj-model-f16.gguf',
        installState: 'remote',
        sizeBytes: 500,
      }),
    ]);
  });

  it('migrates a legacy installed model and projector into installed artifacts', () => {
    const model = makeModel({
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: 'model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      downloadProgress: 1,
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: 1_000,
        checkedAt: 10,
      },
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'supported',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [],
      },
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'test-org/model',
          repoId: 'test-org/model',
          fileName: 'mmproj-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/test-org/model/resolve/main/mmproj-model-f16.gguf',
          size: 500,
          localPath: 'mmproj-model-f16.gguf',
          lifecycleStatus: 'downloaded',
          matchStatus: 'matched',
        },
      ],
      selectedProjectorId: 'projector-a',
    });

    const artifacts = deriveArtifactsFromLegacyModel(model);
    const modelWithArtifacts = { ...model, artifacts };

    expect(isMainArtifactReady(modelWithArtifacts)).toBe(true);
    expect(isMultimodalArtifactReady(modelWithArtifacts)).toBe(true);
    expect(getSelectedProjectorArtifact(modelWithArtifacts)).toEqual(expect.objectContaining({
      id: 'projector-a',
      requiredFor: ['image', 'audio'],
      installState: 'installed',
    }));
    expect(getInstalledArtifactLocalPaths(modelWithArtifacts)).toEqual([
      'model.Q4_K_M.gguf',
      'mmproj-model-f16.gguf',
    ]);
    expect(getTotalInstalledModelBytes(modelWithArtifacts)).toBe(1_500);
    expect(getRequiredDownloadArtifacts(modelWithArtifacts)).toEqual([]);
  });

  it('prefers legacy main download runtime state over stale persisted artifact state', () => {
    const resolvedFileName = 'model.Q4_K_M.gguf';
    const mainArtifactId = buildMainModelArtifactId({
      id: 'test-org/model',
      hfRevision: 'main',
      resolvedFileName,
    });

    const [artifact] = deriveArtifactsFromLegacyModel(makeModel({
      hfRevision: 'main',
      resolvedFileName,
      lifecycleStatus: LifecycleStatus.DOWNLOADING,
      downloadProgress: 0.42,
      resumeData: JSON.stringify({ resumeData: 'fresh-main-resume' }),
      artifacts: [
        {
          id: mainArtifactId,
          kind: 'main_model',
          requiredFor: ['text'],
          hfRevision: 'main',
          remoteFileName: resolvedFileName,
          downloadUrl: 'https://example.com/model.Q4_K_M.gguf',
          sizeBytes: 1_000,
          localPath: 'stale-partial.gguf',
          installState: 'remote',
          downloadProgress: 0.99,
          resumeData: 'stale-main-resume',
          integrity: {
            kind: 'size',
            sizeBytes: 1_000,
            checkedAt: 10,
          },
          errorCode: 'download_http_error',
          errorMessage: 'stale failure',
          updatedAt: 20,
        },
      ],
    }), { preferLegacyRuntimeState: true });

    expect(artifact).toEqual(expect.objectContaining({
      id: mainArtifactId,
      installState: 'downloading',
      downloadProgress: 0.42,
      resumeData: 'fresh-main-resume',
    }));
    expect(artifact?.localPath).toBeUndefined();
    expect(artifact?.integrity).toBeUndefined();
    expect(artifact?.errorCode).toBeUndefined();
    expect(artifact?.errorMessage).toBeUndefined();
    expect(artifact?.updatedAt).toBeUndefined();
  });

  it('clears stale persisted main runtime fields when legacy state becomes installed', () => {
    const resolvedFileName = 'model.Q4_K_M.gguf';
    const mainArtifactId = buildMainModelArtifactId({
      id: 'test-org/model',
      hfRevision: 'main',
      resolvedFileName,
    });

    const [artifact] = deriveArtifactsFromLegacyModel(makeModel({
      hfRevision: 'main',
      resolvedFileName,
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      localPath: resolvedFileName,
      downloadProgress: 1,
      downloadIntegrity: {
        kind: 'size',
        sizeBytes: 1_000,
        checkedAt: 30,
      },
      artifacts: [
        {
          id: mainArtifactId,
          kind: 'main_model',
          requiredFor: ['text'],
          hfRevision: 'main',
          remoteFileName: resolvedFileName,
          downloadUrl: 'https://example.com/model.Q4_K_M.gguf',
          sizeBytes: 1_000,
          localPath: 'stale-partial.gguf',
          installState: 'downloading',
          downloadProgress: 0.5,
          resumeData: 'stale-main-resume',
          errorCode: 'download_http_error',
          errorMessage: 'stale failure',
          updatedAt: 20,
        },
      ],
    }), { preferLegacyRuntimeState: true });

    expect(artifact).toEqual(expect.objectContaining({
      id: mainArtifactId,
      localPath: resolvedFileName,
      installState: 'installed',
      downloadProgress: 1,
      integrity: {
        kind: 'size',
        sizeBytes: 1_000,
        checkedAt: 30,
      },
    }));
    expect(artifact?.resumeData).toBeUndefined();
    expect(artifact?.errorCode).toBeUndefined();
    expect(artifact?.errorMessage).toBeUndefined();
    expect(artifact?.updatedAt).toBeUndefined();
  });

  it('keeps required download artifacts limited to main and selected projector', () => {
    const main: ModelArtifactMetadata = {
      id: 'main-model',
      kind: 'main_model',
      requiredFor: ['text'],
      remoteFileName: 'model.gguf',
      downloadUrl: 'https://example.com/model.gguf',
      sizeBytes: 1,
      installState: 'remote',
    };
    const selected: ModelArtifactMetadata = {
      id: 'projector-selected',
      kind: 'multimodal_projector',
      requiredFor: ['image'],
      remoteFileName: 'mmproj-selected.gguf',
      downloadUrl: 'https://example.com/mmproj-selected.gguf',
      sizeBytes: 1,
      installState: 'remote',
    };
    const other: ModelArtifactMetadata = {
      id: 'projector-other',
      kind: 'multimodal_projector',
      requiredFor: ['image'],
      remoteFileName: 'mmproj-other.gguf',
      downloadUrl: 'https://example.com/mmproj-other.gguf',
      sizeBytes: 1,
      installState: 'remote',
    };

    expect(getRequiredDownloadArtifacts({
      artifacts: [main, selected, other],
      selectedProjectorId: selected.id,
    })).toEqual([main, selected]);
  });

  it('normalizes persisted artifacts and drops unsafe local paths', () => {
    expect(normalizePersistedModelArtifacts([
      {
        id: 'main-model',
        kind: 'main_model',
        requiredFor: ['text', 'bogus'],
        remoteFileName: 'model.gguf',
        downloadUrl: 'https://example.com/model.gguf',
        sizeBytes: 100,
        localPath: '../escape.gguf',
        installState: 'installed',
        integrity: {
          kind: 'sha256',
          sizeBytes: 100,
          checkedAt: 10,
          sha256: 'a'.repeat(64),
        },
      },
      {
        id: 'main-model',
        kind: 'main_model',
        requiredFor: ['text'],
        remoteFileName: 'duplicate.gguf',
        downloadUrl: 'https://example.com/duplicate.gguf',
        sizeBytes: 200,
        installState: 'remote',
      },
      {
        id: 'broken',
        kind: 'main_model',
        requiredFor: [],
        remoteFileName: 'broken.gguf',
        downloadUrl: 'https://example.com/broken.gguf',
        installState: 'remote',
      },
    ])).toEqual([
      {
        id: 'main-model',
        kind: 'main_model',
        requiredFor: ['text'],
        remoteFileName: 'model.gguf',
        downloadUrl: 'https://example.com/model.gguf',
        sizeBytes: 100,
        installState: 'installed',
        integrity: {
          kind: 'sha256',
          sizeBytes: 100,
          checkedAt: 10,
          sha256: 'a'.repeat(64),
        },
      },
    ]);
  });

  it('can sync legacy main fields from the selected main artifact', () => {
    const model = makeModel({
      artifacts: [
        {
          id: 'main-model',
          kind: 'main_model',
          requiredFor: ['text'],
          hfRevision: 'revision-a',
          remoteFileName: 'model.Q8_0.gguf',
          downloadUrl: 'https://example.com/model.Q8_0.gguf',
          sizeBytes: 2_000,
          sha256: 'b'.repeat(64),
          localPath: 'model.Q8_0.gguf',
          installState: 'installed',
          downloadProgress: 1,
        },
      ],
    });

    expect(syncLegacyMainArtifactFields(model)).toEqual(expect.objectContaining({
      downloadUrl: 'https://example.com/model.Q8_0.gguf',
      hfRevision: 'revision-a',
      resolvedFileName: 'model.Q8_0.gguf',
      size: 2_000,
      sha256: 'b'.repeat(64),
      localPath: 'model.Q8_0.gguf',
      downloadProgress: 1,
    }));
  });
});
