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
  mergeModelArtifacts,
  normalizePersistedModelArtifacts,
  syncLegacyMainArtifactFields,
} from '../../src/utils/modelArtifacts';
import { buildProjectorArtifactId } from '../../src/utils/modelProjectors';

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
      downloadUrl: 'https://huggingface.co/test-org/model/resolve/abc123/model.Q4_K_M.gguf',
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'test-org/model',
          repoId: 'test-org/model',
          fileName: 'mmproj-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/test-org/model/resolve/abc123/mmproj-model-f16.gguf',
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
        id: buildProjectorArtifactId({
          repoId: 'test-org/model',
          hfRevision: 'abc123',
          fileName: 'mmproj-model-f16.gguf',
        }),
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
      id: buildProjectorArtifactId({
        repoId: 'test-org/model',
        fileName: 'mmproj-model-f16.gguf',
      }),
      requiredFor: ['audio', 'image'],
      installState: 'installed',
    }));
    expect(getInstalledArtifactLocalPaths(modelWithArtifacts)).toEqual([
      'model.Q4_K_M.gguf',
      'mmproj-model-f16.gguf',
    ]);
    expect(getTotalInstalledModelBytes(modelWithArtifacts)).toBe(1_500);
    expect(getRequiredDownloadArtifacts(modelWithArtifacts)).toEqual([]);
  });

  it('derives audio-only projector required inputs without adding image', () => {
    const artifacts = deriveArtifactsFromLegacyModel(makeModel({
      chatModalities: ['text', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'unknown',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [{ source: 'pipeline_tag', value: 'automatic-speech-recognition', confidence: 'high' }],
      },
      projectorCandidates: [
        {
          id: 'projector-audio',
          ownerModelId: 'test-org/model',
          repoId: 'test-org/model',
          fileName: 'mmproj-audio-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/test-org/model/resolve/main/mmproj-audio-model-f16.gguf',
          size: 500,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
      ],
    }));

    expect(artifacts).toEqual([
      expect.objectContaining({
        id: buildProjectorArtifactId({
          repoId: 'test-org/model',
          fileName: 'mmproj-audio-model-f16.gguf',
        }),
        kind: 'multimodal_projector',
        requiredFor: ['audio'],
      }),
    ]);
  });

  it('does not turn stale requested vision into a synthesized image requirement for an audio-only model', () => {
    const artifacts = deriveArtifactsFromLegacyModel(makeModel({
      chatModalities: ['text', 'audio'],
      multimodalReadiness: {
        modelId: 'test-org/model',
        status: 'ready',
        projectorId: 'projector-audio',
        support: ['audio'],
        requestedSupport: ['vision', 'audio'],
        checkedAt: 1,
      },
      projectorCandidates: [{
        id: 'projector-audio',
        ownerModelId: 'test-org/model',
        repoId: 'test-org/model',
        fileName: 'mmproj-audio-f16.gguf',
        downloadUrl: 'https://example.com/mmproj-audio-f16.gguf',
        size: 500,
        lifecycleStatus: 'downloaded',
        matchStatus: 'matched',
      }],
    }));

    expect(artifacts).toEqual([
      expect.objectContaining({
        id: buildProjectorArtifactId({
          repoId: 'test-org/model',
          fileName: 'mmproj-audio-f16.gguf',
        }),
        requiredFor: ['audio'],
      }),
    ]);
  });

  it('keeps projector-specific required inputs when legacy model metadata is mixed', () => {
    const projector = (id: string, fileName: string) => ({
      id,
      ownerModelId: 'test-org/model',
      repoId: 'test-org/model',
      fileName,
      downloadUrl: `https://huggingface.co/test-org/model/resolve/main/${fileName}`,
      size: 500,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    });
    const persistedArtifact = (
      id: string,
      fileName: string,
      requiredFor: ModelArtifactMetadata['requiredFor'],
    ): ModelArtifactMetadata => ({
      id,
      kind: 'multimodal_projector',
      requiredFor,
      remoteFileName: fileName,
      downloadUrl: `https://huggingface.co/test-org/model/resolve/main/${fileName}`,
      sizeBytes: 500,
      installState: 'remote',
    });
    const visionProjector = projector('projector-vision', 'mmproj-vision-f16.gguf');
    const audioProjector = projector('projector-audio', 'mmproj-audio-f16.gguf');

    const artifacts = deriveArtifactsFromLegacyModel(makeModel({
      chatModalities: ['text', 'vision', 'audio'],
      inputCapabilities: {
        detectedAt: 1,
        declared: {
          image: 'supported',
          audio: 'supported',
          video: 'unknown',
        },
        evidence: [],
      },
      projectorCandidates: [visionProjector, audioProjector],
      artifacts: [
        persistedArtifact(visionProjector.id, visionProjector.fileName, ['image']),
        persistedArtifact(audioProjector.id, audioProjector.fileName, ['audio']),
      ],
    }), { preferLegacyRuntimeState: true });

    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: buildProjectorArtifactId(visionProjector),
        requiredFor: ['image'],
      }),
      expect.objectContaining({
        id: buildProjectorArtifactId(audioProjector),
        requiredFor: ['audio'],
      }),
    ]));
    expect(artifacts).toHaveLength(2);
  });

  it('preserves exact Hugging Face projector requirements across query and fragment URL metadata', () => {
    const fileName = 'Projectors/MMProj-Audio.GGUF';
    const downloadUrl = `https://huggingface.co/test-org/model/resolve/main/${fileName}`;
    const projector = {
      id: 'projector-audio',
      ownerModelId: 'test-org/model',
      repoId: 'test-org/model',
      fileName,
      downloadUrl,
      hfRevision: 'main',
      size: 500,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const artifacts = deriveArtifactsFromLegacyModel(makeModel({
      chatModalities: ['text', 'vision', 'audio'],
      projectorCandidates: [projector],
      artifacts: [{
        id: projector.id,
        kind: 'multimodal_projector',
        requiredFor: ['audio'],
        hfRevision: 'main',
        remoteFileName: fileName,
        downloadUrl: `${downloadUrl}?download=1#artifact`,
        sizeBytes: projector.size,
        installState: 'remote',
      }],
    }), { preferLegacyRuntimeState: true });

    expect(artifacts).toEqual([expect.objectContaining({
      id: buildProjectorArtifactId(projector),
      requiredFor: ['audio'],
      downloadUrl,
    })]);
  });

  it('preserves projector requirements for an exact ordinary HTTP mirror identity', () => {
    const downloadUrl = 'http://example.com/projectors/mmproj-audio.gguf';
    const projector = {
      id: 'projector-audio',
      ownerModelId: 'test-org/model',
      repoId: 'test-org/model',
      fileName: 'projectors/mmproj-audio.gguf',
      downloadUrl,
      size: 500,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const artifacts = deriveArtifactsFromLegacyModel(makeModel({
      chatModalities: ['text', 'vision', 'audio'],
      projectorCandidates: [projector],
      artifacts: [{
        id: projector.id,
        kind: 'multimodal_projector',
        requiredFor: ['audio'],
        remoteFileName: projector.fileName,
        downloadUrl,
        sizeBytes: projector.size,
        installState: 'remote',
      }],
    }), { preferLegacyRuntimeState: true });

    expect(artifacts).toEqual([expect.objectContaining({ requiredFor: ['audio'] })]);
  });

  it.each(['huggingface.co', 'hf.co'])(
    'does not preserve projector requirements across an invalid HTTP %s identity',
    (host) => {
      const downloadUrl = `http://${host}/test-org/model/resolve/main/mmproj-audio.gguf`;
      const projector = {
        id: 'projector-audio',
        ownerModelId: 'test-org/model',
        repoId: 'test-org/model',
        fileName: 'mmproj-audio.gguf',
        downloadUrl,
        hfRevision: 'main',
        size: 500,
        lifecycleStatus: 'available' as const,
        matchStatus: 'matched' as const,
      };
      const artifacts = deriveArtifactsFromLegacyModel(makeModel({
        chatModalities: ['text', 'vision', 'audio'],
        projectorCandidates: [projector],
        artifacts: [{
          id: projector.id,
          kind: 'multimodal_projector',
          requiredFor: ['audio'],
          hfRevision: 'main',
          remoteFileName: projector.fileName,
          downloadUrl,
          sizeBytes: projector.size,
          installState: 'remote',
        }],
      }), { preferLegacyRuntimeState: true });

      expect(artifacts).toEqual([]);
    },
  );

  it.each(['huggingface.co.', 'hf.co.'])(
    'drops a root-dotted %s projector candidate and artifact instead of treating them as mirrors',
    (host) => {
      const fileName = 'audio/mmproj-audio.gguf';
      const downloadUrl = `https://${host}/test-org/model/resolve/main/${fileName}`;
      const malformedArtifact: ModelArtifactMetadata = {
        id: 'projector-audio',
        kind: 'multimodal_projector',
        requiredFor: ['audio'],
        hfRevision: 'main',
        remoteFileName: fileName,
        downloadUrl,
        sizeBytes: 500,
        installState: 'remote',
      };
      const artifacts = deriveArtifactsFromLegacyModel(makeModel({
        chatModalities: ['text', 'vision', 'audio'],
        projectorCandidates: [{
          id: malformedArtifact.id,
          ownerModelId: 'test-org/model',
          repoId: 'test-org/model',
          fileName,
          downloadUrl,
          hfRevision: 'main',
          size: malformedArtifact.sizeBytes,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        }],
        artifacts: [malformedArtifact],
      }), { preferLegacyRuntimeState: true });

      expect(artifacts).toEqual([]);
      expect(normalizePersistedModelArtifacts([malformedArtifact])).toBeUndefined();
    },
  );

  it('drops copied Hugging Face projector metadata whose own path disagrees with its URL', () => {
    const malformedArtifact: ModelArtifactMetadata = {
      id: 'projector-self-mismatch',
      kind: 'multimodal_projector',
      requiredFor: ['audio'],
      hfRevision: 'main',
      remoteFileName: 'audio/mmproj.gguf',
      downloadUrl: 'https://huggingface.co/test-org/model/resolve/main/vision/mmproj.gguf',
      sizeBytes: 500,
      installState: 'remote',
    };
    const artifacts = deriveArtifactsFromLegacyModel(makeModel({
      chatModalities: ['text', 'vision', 'audio'],
      projectorCandidates: [{
        id: malformedArtifact.id,
        ownerModelId: 'test-org/model',
        repoId: 'test-org/model',
        fileName: malformedArtifact.remoteFileName,
        downloadUrl: malformedArtifact.downloadUrl,
        hfRevision: malformedArtifact.hfRevision,
        size: malformedArtifact.sizeBytes,
        lifecycleStatus: 'available',
        matchStatus: 'matched',
      }],
      artifacts: [malformedArtifact],
    }), { preferLegacyRuntimeState: true });

    expect(artifacts).toEqual([]);
    expect(normalizePersistedModelArtifacts([malformedArtifact])).toBeUndefined();
  });

  it('drops copied ordinary-mirror projector metadata whose path disagrees with its URL', () => {
    const malformedArtifact: ModelArtifactMetadata = {
      id: 'projector-mirror-mismatch',
      kind: 'multimodal_projector',
      requiredFor: ['audio'],
      hfRevision: 'main',
      remoteFileName: 'audio/mmproj.gguf',
      downloadUrl: 'https://mirror.example/vision/mmproj.gguf',
      sizeBytes: 500,
      installState: 'remote',
    };

    expect(normalizePersistedModelArtifacts([malformedArtifact])).toBeUndefined();
  });

  it.each([
    ['filename', { remoteFileName: 'mmproj-old-f16.gguf' }],
    ['full path', { remoteFileName: 'stale/mmproj-model-f16.gguf' }],
    ['filename case', { remoteFileName: 'MMProj-model-f16.gguf' }],
    ['revision', { hfRevision: 'refs/pr/1' }],
    ['sha256', { sha256: 'b'.repeat(64) }],
    ['size', { sizeBytes: 501 }],
    ['download URL', { downloadUrl: 'https://mirror.example/mmproj-model-f16.gguf' }],
  ] as const)('does not preserve projector requirements across a conflicting stable %s identity', (
    _label,
    persistedOverrides,
  ) => {
    const fileName = 'mmproj-model-f16.gguf';
    const downloadUrl = `https://huggingface.co/test-org/model/resolve/main/${fileName}`;
    const projector = {
      id: 'projector-shared-id',
      ownerModelId: 'test-org/model',
      repoId: 'test-org/model',
      fileName,
      downloadUrl,
      hfRevision: 'main',
      sha256: 'a'.repeat(64),
      size: 500,
      lifecycleStatus: 'available' as const,
      matchStatus: 'matched' as const,
    };
    const persistedArtifact: ModelArtifactMetadata = {
      id: projector.id,
      kind: 'multimodal_projector',
      requiredFor: ['audio'],
      hfRevision: projector.hfRevision,
      remoteFileName: projector.fileName,
      downloadUrl: projector.downloadUrl,
      sizeBytes: projector.size,
      sha256: projector.sha256,
      installState: 'remote',
      ...persistedOverrides,
    };

    const artifacts = deriveArtifactsFromLegacyModel(makeModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: [projector],
      artifacts: [persistedArtifact],
    }), { preferLegacyRuntimeState: true });

    expect(artifacts).toEqual([]);
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

  it('adds the enabled Gemma MTP draft to required download artifacts', () => {
    const main: ModelArtifactMetadata = {
      id: 'main-model',
      kind: 'main_model',
      requiredFor: ['text'],
      remoteFileName: 'gemma.gguf',
      downloadUrl: 'https://example.com/gemma.gguf',
      sizeBytes: 1_000,
      installState: 'remote',
    };
    const draft: ModelArtifactMetadata = {
      id: 'mtp-draft',
      kind: 'speculative_draft',
      requiredFor: ['text'],
      remoteFileName: 'MTP/gemma-MTP.gguf',
      downloadUrl: 'https://example.com/gemma-MTP.gguf',
      sizeBytes: 200,
      installState: 'remote',
    };

    const model = {
      artifacts: [main, draft],
      speculativeDecoding: {
        type: 'mtp' as const,
        mode: 'draft_model' as const,
        enabled: true,
        maxDraftTokens: 3,
        draftArtifactId: draft.id,
      },
    };

    expect(getRequiredDownloadArtifacts(model)).toEqual([main, draft]);
    expect(getRequiredDownloadArtifacts(model, false)).toEqual([main]);
  });

  it('preserves installed MTP draft runtime state only while remote identity is unchanged', () => {
    const remoteDraft: ModelArtifactMetadata = {
      id: 'mtp-draft',
      kind: 'speculative_draft',
      requiredFor: ['text'],
      hfRevision: 'revision-a',
      remoteFileName: 'MTP/gemma-MTP.gguf',
      downloadUrl: 'https://example.com/MTP/gemma-MTP.gguf',
      sizeBytes: 200,
      installState: 'remote',
    };
    const installedDraft: ModelArtifactMetadata = {
      ...remoteDraft,
      localPath: 'gemma-mtp.gguf',
      installState: 'installed',
      downloadProgress: 1,
      integrity: {
        kind: 'size',
        sizeBytes: 200,
        checkedAt: 10,
      },
    };

    expect(mergeModelArtifacts([remoteDraft], [installedDraft], {
      preferDerivedRuntimeState: true,
    })).toEqual([
      expect.objectContaining({
        id: 'mtp-draft',
        localPath: 'gemma-mtp.gguf',
        installState: 'installed',
        downloadProgress: 1,
      }),
    ]);

    expect(mergeModelArtifacts([{
      ...remoteDraft,
      hfRevision: 'revision-b',
      downloadUrl: 'https://example.com/revision-b/MTP/gemma-MTP.gguf',
    }], [installedDraft], {
      preferDerivedRuntimeState: true,
    })).toEqual([
      expect.objectContaining({
        id: 'mtp-draft',
        hfRevision: 'revision-b',
        installState: 'remote',
      }),
    ]);
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
