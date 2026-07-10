import type { ProjectorArtifact } from '../../src/types/multimodal';
import type { ModelMetadata } from '../../src/types/models';
import { ModelAccessState, LifecycleStatus } from '../../src/types/models';
import {
  buildModelDetailsHeroMetrics,
  buildModelDetailsMetadataMetrics,
  createModelDetailsPlaceholder,
} from '../../src/utils/modelDetailsPresentation';

const t = (key: string) => (key === 'models.sizeUnknown' ? 'Unknown' : key);

function createModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 3_800_000_000,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    ...overrides,
  };
}

function createProjectorArtifact(
  projector: Pick<ProjectorArtifact, 'id' | 'fileName'> & Partial<ProjectorArtifact>,
): ProjectorArtifact {
  return {
    ownerModelId: 'org/model',
    repoId: 'org/model',
    downloadUrl: `https://huggingface.co/org/model/resolve/main/${projector.fileName}`,
    size: 200_000_000,
    lifecycleStatus: 'available',
    matchStatus: 'matched',
    ...projector,
  };
}

describe('modelDetailsPresentation', () => {
  it('uses the short repo label in placeholder model details', () => {
    const placeholder = createModelDetailsPlaceholder('author/model-q4');

    expect(placeholder).toEqual(expect.objectContaining({
      id: 'author/model-q4',
      name: 'model-q4',
      author: 'author',
      accessState: ModelAccessState.PUBLIC,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
    }));
  });

  it('includes active variant projector bytes in hero file size metrics', () => {
    const metrics = buildModelDetailsHeroMetrics({
      id: 'org/model',
      name: 'Model',
      author: 'org',
      size: 3_800_000_000,
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [{
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 3_800_000_000,
        projectorCandidates: [{
          id: 'projector-org-model-main-mmproj-model-f16.gguf',
          ownerModelId: 'org/model',
          ownerVariantId: 'model.Q4_K_M.gguf',
          repoId: 'org/model',
          fileName: 'mmproj-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
          size: 200_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        }],
      }],
    }, (key) => (key === 'models.sizeUnknown' ? 'Unknown' : key));

    expect(metrics[0]).toEqual(expect.objectContaining({
      label: 'models.fileSizeLabel',
      value: '4.00 GB',
    }));
  });

  it('shows a compatible selected model-wide projector beside active-variant metadata', () => {
    const variantProjector = createProjectorArtifact({
      id: 'projector-variant-q4',
      ownerVariantId: 'q4',
      fileName: 'mmproj-variant-q4.gguf',
      size: 200_000_000,
    });
    const modelWideProjector = createProjectorArtifact({
      id: 'projector-model-wide',
      fileName: 'mmproj-model-wide.gguf',
      size: 500_000_000,
      lifecycleStatus: 'downloaded',
      matchStatus: 'user_selected',
      localPath: 'mmproj-model-wide.gguf',
    });
    const model = createModel({
      chatModalities: ['text', 'vision'],
      activeVariantId: 'q4',
      resolvedFileName: 'model.Q4_K_M.gguf',
      selectedProjectorId: modelWideProjector.id,
      variants: [{
        variantId: 'q4',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 3_800_000_000,
        chatModalities: ['text', 'vision'],
        projectorCandidates: [variantProjector],
      }],
      projectorCandidates: [modelWideProjector],
      artifacts: [{
        id: modelWideProjector.id,
        kind: 'multimodal_projector',
        requiredFor: ['image'],
        remoteFileName: modelWideProjector.fileName,
        downloadUrl: modelWideProjector.downloadUrl,
        sizeBytes: modelWideProjector.size,
        localPath: modelWideProjector.localPath,
        installState: 'installed',
      }],
    });

    expect(buildModelDetailsHeroMetrics(model, t)[0]).toEqual(expect.objectContaining({
      value: '4.30 GB',
    }));
    expect(buildModelDetailsMetadataMetrics(model, t)).toContainEqual({
      label: 'models.multimodal.projectorCandidates',
      value: 'mmproj-variant-q4.gguf, mmproj-model-wide.gguf',
    });
  });

  it('uses only active-variant compatible projectors for stale selected projector details', () => {
    const model = {
      id: 'org/model',
      name: 'Model',
      author: 'org',
      size: 3_800_000_000,
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.Q4_K_M.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      chatModalities: ['text' as const, 'vision' as const],
      artifactRole: 'primary_chat_model' as const,
      activeVariantId: 'model.Q4_K_M.gguf',
      resolvedFileName: 'model.Q4_K_M.gguf',
      selectedProjectorId: 'projector-q8',
      variants: [
        {
          variantId: 'model.Q4_K_M.gguf',
          fileName: 'model.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 3_800_000_000,
        },
        {
          variantId: 'model.Q8_0.gguf',
          fileName: 'model.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 7_200_000_000,
        },
      ],
      projectorCandidates: [
        {
          id: 'projector-q4',
          ownerModelId: 'org/model',
          ownerVariantId: 'model.Q4_K_M.gguf',
          repoId: 'org/model',
          fileName: 'mmproj-q4.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q4.gguf',
          size: 200_000_000,
          lifecycleStatus: 'available' as const,
          matchStatus: 'matched' as const,
        },
        {
          id: 'projector-q8',
          ownerModelId: 'org/model',
          ownerVariantId: 'model.Q8_0.gguf',
          repoId: 'org/model',
          fileName: 'mmproj-q8.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-q8.gguf',
          size: 500_000_000,
          lifecycleStatus: 'available' as const,
          matchStatus: 'user_selected' as const,
        },
      ],
    };

    const heroMetrics = buildModelDetailsHeroMetrics(model, t);
    const metadataMetrics = buildModelDetailsMetadataMetrics(model, t);

    expect(heroMetrics[0]).toEqual(expect.objectContaining({ value: '4.00 GB' }));
    expect(metadataMetrics).toContainEqual(expect.objectContaining({
      label: 'models.multimodal.projectorCandidates',
      value: 'mmproj-q4.gguf',
    }));
    expect(metadataMetrics).not.toContainEqual(expect.objectContaining({
      label: 'models.multimodal.projectorCandidates',
      value: expect.stringContaining('mmproj-q8.gguf'),
    }));
  });

  it('shows projector candidates for audio-only native multimodal models without vision status', () => {
    const model = createModel({
      chatModalities: ['text', 'audio'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [
        createProjectorArtifact({
          id: 'projector-audio',
          fileName: 'mmproj-audio.gguf',
        }),
      ],
    });

    const metadataMetrics = buildModelDetailsMetadataMetrics(model, t);

    expect(metadataMetrics).toContainEqual({
      label: 'models.multimodal.projectorCandidates',
      value: 'mmproj-audio.gguf',
    });
    expect(metadataMetrics).not.toContainEqual(expect.objectContaining({
      label: 'models.vision.capabilityLabel',
    }));
  });

  it('hides projector candidates for text-only models without native multimodal support', () => {
    const model = createModel({
      chatModalities: ['text'],
      artifactRole: 'primary_chat_model',
      projectorCandidates: [
        createProjectorArtifact({
          id: 'projector-stale',
          fileName: 'mmproj-stale.gguf',
        }),
      ],
    });

    const metadataMetrics = buildModelDetailsMetadataMetrics(model, t);

    expect(metadataMetrics).not.toContainEqual(expect.objectContaining({
      label: 'models.multimodal.projectorCandidates',
    }));
  });

  it('uses only active-variant compatible projectors for audio-only variant details', () => {
    const model = createModel({
      chatModalities: ['text', 'audio'],
      artifactRole: 'primary_chat_model',
      activeVariantId: 'model-audio.Q4_K_M.gguf',
      resolvedFileName: 'model-audio.Q4_K_M.gguf',
      selectedProjectorId: 'projector-audio-q8',
      variants: [
        {
          variantId: 'model-audio.Q4_K_M.gguf',
          fileName: 'model-audio.Q4_K_M.gguf',
          quantizationLabel: 'Q4_K_M',
          size: 3_800_000_000,
          chatModalities: ['text', 'audio'],
          artifactRole: 'primary_chat_model',
          projectorCandidates: [
            createProjectorArtifact({
              id: 'projector-audio-q4',
              ownerVariantId: 'model-audio.Q4_K_M.gguf',
              fileName: 'mmproj-audio-q4.gguf',
            }),
          ],
        },
        {
          variantId: 'model-audio.Q8_0.gguf',
          fileName: 'model-audio.Q8_0.gguf',
          quantizationLabel: 'Q8_0',
          size: 7_200_000_000,
          chatModalities: ['text', 'audio'],
          artifactRole: 'primary_chat_model',
          projectorCandidates: [
            createProjectorArtifact({
              id: 'projector-audio-q8',
              ownerVariantId: 'model-audio.Q8_0.gguf',
              fileName: 'mmproj-audio-q8.gguf',
            }),
          ],
        },
      ],
      projectorCandidates: [
        createProjectorArtifact({
          id: 'projector-audio-q8',
          ownerVariantId: 'model-audio.Q8_0.gguf',
          fileName: 'mmproj-audio-q8.gguf',
        }),
      ],
    });

    const metadataMetrics = buildModelDetailsMetadataMetrics(model, t);

    expect(metadataMetrics).toContainEqual({
      label: 'models.multimodal.projectorCandidates',
      value: 'mmproj-audio-q4.gguf',
    });
    expect(metadataMetrics).not.toContainEqual(expect.objectContaining({
      label: 'models.multimodal.projectorCandidates',
      value: expect.stringContaining('mmproj-audio-q8.gguf'),
    }));
  });

  it('excludes vision-only projector metadata and bytes from active audio-only details', () => {
    const audioProjector = createProjectorArtifact({
      id: 'projector-audio',
      ownerVariantId: 'audio-q4',
      fileName: 'mmproj-audio.gguf',
      hfRevision: 'main',
      size: 200_000_000,
    });
    const visionProjector = createProjectorArtifact({
      id: 'projector-vision',
      ownerVariantId: 'audio-q4',
      fileName: 'mmproj-vision.gguf',
      hfRevision: 'main',
      size: 500_000_000,
      matchStatus: 'user_selected',
    });
    const model = createModel({
      size: 3_800_000_000,
      chatModalities: ['text', 'vision'],
      activeVariantId: 'audio-q4',
      resolvedFileName: 'audio.Q4.gguf',
      selectedProjectorId: visionProjector.id,
      variants: [{
        variantId: 'audio-q4',
        fileName: 'audio.Q4.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 3_800_000_000,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [audioProjector, visionProjector],
      }],
      projectorCandidates: [audioProjector, visionProjector],
      artifacts: [
        {
          id: audioProjector.id,
          kind: 'multimodal_projector',
          requiredFor: ['audio'],
          hfRevision: 'main',
          remoteFileName: audioProjector.fileName,
          downloadUrl: audioProjector.downloadUrl,
          sizeBytes: audioProjector.size,
          installState: 'remote',
        },
        {
          id: visionProjector.id,
          kind: 'multimodal_projector',
          requiredFor: ['image'],
          hfRevision: 'main',
          remoteFileName: visionProjector.fileName,
          downloadUrl: visionProjector.downloadUrl,
          sizeBytes: visionProjector.size,
          installState: 'remote',
        },
      ],
    });

    const heroMetrics = buildModelDetailsHeroMetrics(model, t);
    const metadataMetrics = buildModelDetailsMetadataMetrics(model, t);

    expect(heroMetrics[0]).toEqual(expect.objectContaining({ value: '4.00 GB' }));
    expect(metadataMetrics).toContainEqual({
      label: 'models.multimodal.projectorCandidates',
      value: 'mmproj-audio.gguf',
    });
    expect(metadataMetrics).not.toContainEqual(expect.objectContaining({
      value: expect.stringContaining('mmproj-vision.gguf'),
    }));
    expect(metadataMetrics).not.toContainEqual(expect.objectContaining({
      label: 'models.vision.capabilityLabel',
    }));
  });
});
