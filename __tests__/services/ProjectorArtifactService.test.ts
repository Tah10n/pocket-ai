import { ProjectorArtifactService } from '../../src/services/ProjectorArtifactService';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import {
  alternateProjectorFileName,
  projectorFileName,
  visionModelFileName,
  visionModelRepoId,
} from '../fixtures/multimodalCatalogFixtures';
import { buildProjectorArtifactId } from '../../src/utils/modelProjectors';

function createProjector(fileName: string, overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  const ownerVariantId = overrides.ownerVariantId ?? visionModelFileName;
  return {
    id: buildProjectorArtifactId({
      repoId: visionModelRepoId,
      hfRevision: 'main',
      ownerVariantId,
      fileName,
    }),
    ownerModelId: visionModelRepoId,
    ownerVariantId,
    repoId: visionModelRepoId,
    fileName,
    downloadUrl: `https://huggingface.co/${visionModelRepoId}/resolve/main/${fileName}`,
    size: 512,
    lifecycleStatus: 'available',
    matchStatus: 'missing',
    ...overrides,
  };
}

function createRepoLevelProjector(fileName: string, overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  return createProjector(fileName, {
    ...overrides,
    id: buildProjectorArtifactId({
      repoId: visionModelRepoId,
      hfRevision: 'main',
      fileName,
    }),
    ownerVariantId: undefined,
  });
}

function createVisionModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: visionModelRepoId,
    name: 'Vision Chat',
    author: 'test-org',
    size: 4_000_000_000,
    downloadUrl: `https://huggingface.co/${visionModelRepoId}/resolve/main/${visionModelFileName}`,
    resolvedFileName: visionModelFileName,
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    activeVariantId: visionModelFileName,
    chatModalities: ['text', 'vision'],
    variants: [
      {
        variantId: visionModelFileName,
        fileName: visionModelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
      },
    ],
    ...overrides,
  };
}

describe('ProjectorArtifactService', () => {
  it('resolves a single compatible projector without requiring user choice', () => {
    const projector = createProjector(projectorFileName);
    const service = new ProjectorArtifactService();

    expect(service.resolveProjectorForModel(createVisionModel({
      projectorCandidates: [projector],
    }))).toEqual(expect.objectContaining({
      status: 'matched',
      reason: 'single_projector_candidate',
      selectedProjector: expect.objectContaining({ id: projector.id }),
    }));
  });

  it('keeps repo-level projector candidates available after switching GGUF variants', () => {
    const projector = createRepoLevelProjector(projectorFileName);
    const alternateVariantFileName = 'vision-chat-model-Q8_0.gguf';
    const service = new ProjectorArtifactService();

    expect(service.resolveProjectorForModel(createVisionModel({
      resolvedFileName: alternateVariantFileName,
      activeVariantId: alternateVariantFileName,
      variants: [
        createVisionModel().variants![0],
        {
          variantId: alternateVariantFileName,
          fileName: alternateVariantFileName,
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
        },
      ],
      projectorCandidates: [projector],
    }))).toEqual(expect.objectContaining({
      status: 'matched',
      reason: 'single_projector_candidate',
      selectedProjector: expect.objectContaining({ id: projector.id }),
    }));
  });

  it('does not treat projectors for another GGUF variant as compatible after a variant switch', () => {
    const projector = createProjector(projectorFileName);
    const alternateVariantFileName = 'vision-chat-model-Q8_0.gguf';
    const service = new ProjectorArtifactService();

    const resolution = service.resolveProjectorForModel(createVisionModel({
      resolvedFileName: alternateVariantFileName,
      activeVariantId: alternateVariantFileName,
      variants: [
        createVisionModel().variants![0],
        {
          variantId: alternateVariantFileName,
          fileName: alternateVariantFileName,
          quantizationLabel: 'Q8_0',
          size: 8_000_000_000,
        },
      ],
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
    }));

    expect(resolution.status).toBe('missing');
    expect(resolution.reason).toBe('no_projector_candidates');
    expect(resolution.selectedProjector).toBeUndefined();
    expect(resolution.candidates).toEqual([]);
  });

  it('uses deterministic filename affinity when multiple candidates are present', () => {
    const matchingProjector = createProjector(projectorFileName);
    const unrelatedProjector = createProjector('mmproj-unrelated-model-f16.gguf');
    const service = new ProjectorArtifactService();

    expect(service.resolveProjectorForModel(createVisionModel({
      projectorCandidates: [unrelatedProjector, matchingProjector],
    }))).toEqual(expect.objectContaining({
      status: 'matched',
      reason: 'deterministic_projector_candidate',
      selectedProjector: expect.objectContaining({ id: matchingProjector.id }),
    }));
  });

  it('reports ambiguity when tied candidates cannot be safely selected', () => {
    const service = new ProjectorArtifactService();

    const resolution = service.resolveProjectorForModel(createVisionModel({
      projectorCandidates: [
        createProjector(projectorFileName),
        createProjector(alternateProjectorFileName),
      ],
    }));

    expect(resolution.status).toBe('ambiguous');
    expect(resolution.reason).toBe('ambiguous_projector_candidates');
    expect(resolution.selectedProjector).toBeUndefined();
    expect(resolution.candidates).toEqual([
      expect.objectContaining({ matchStatus: 'ambiguous' }),
      expect.objectContaining({ matchStatus: 'ambiguous' }),
    ]);
  });

  it('persists explicit user projector selection on the owning model', () => {
    const firstProjector = createProjector(projectorFileName);
    const secondProjector = createProjector(alternateProjectorFileName, { matchStatus: 'user_selected' });
    const model = createVisionModel({
      selectedProjectorId: secondProjector.id,
      projectorCandidates: [firstProjector, secondProjector],
    });
    const modelRegistry = {
      getModel: jest.fn().mockReturnValue(model),
      updateModel: jest.fn(),
    };
    const service = new ProjectorArtifactService(modelRegistry);

    const resolution = service.selectProjector(model.id, firstProjector.id);

    expect(modelRegistry.updateModel).toHaveBeenCalledWith(expect.objectContaining({
      selectedProjectorId: firstProjector.id,
      visionSource: 'user_selected_projector',
      projectorCandidates: [
        expect.objectContaining({
          id: firstProjector.id,
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        }),
        expect.objectContaining({
          id: secondProjector.id,
          matchStatus: 'ambiguous',
          matchReason: 'unselected_projector_candidate',
        }),
      ],
    }));
    expect(resolution).toEqual(expect.objectContaining({
      status: 'user_selected',
      reason: 'selected_projector',
      selectedProjector: expect.objectContaining({ id: firstProjector.id }),
    }));
  });

  it('clears stale multimodal readiness when selecting a different projector', () => {
    const firstProjector = createProjector(projectorFileName);
    const secondProjector = createProjector(alternateProjectorFileName, { matchStatus: 'user_selected' });
    const model = createVisionModel({
      selectedProjectorId: secondProjector.id,
      projectorCandidates: [firstProjector, secondProjector],
      multimodalReadiness: {
        modelId: visionModelRepoId,
        status: 'ready',
        projectorId: secondProjector.id,
        support: ['vision'],
        checkedAt: 123,
      },
    });
    const service = new ProjectorArtifactService();

    const selection = service.selectProjectorForModel(model, firstProjector.id);

    expect(selection.model).toEqual(expect.objectContaining({
      selectedProjectorId: firstProjector.id,
      multimodalReadiness: undefined,
    }));
  });

  it('preserves multimodal readiness when reselecting the same projector', () => {
    const firstProjector = createProjector(projectorFileName, { matchStatus: 'user_selected' });
    const readiness = {
      modelId: visionModelRepoId,
      status: 'ready' as const,
      projectorId: firstProjector.id,
      support: ['vision' as const],
      checkedAt: 123,
    };
    const model = createVisionModel({
      selectedProjectorId: firstProjector.id,
      projectorCandidates: [firstProjector],
      multimodalReadiness: readiness,
    });
    const service = new ProjectorArtifactService();

    const selection = service.selectProjectorForModel(model, firstProjector.id);

    expect(selection.model).toEqual(expect.objectContaining({
      selectedProjectorId: firstProjector.id,
      multimodalReadiness: readiness,
    }));
  });

  it('selects a projector on an unresolved catalog model without requiring registry persistence', () => {
    const firstProjector = createProjector(projectorFileName);
    const secondProjector = createProjector(alternateProjectorFileName);
    const model = createVisionModel({
      projectorCandidates: [firstProjector, secondProjector],
    });
    const service = new ProjectorArtifactService({
      getModel: jest.fn(),
      updateModel: jest.fn(),
    });

    const selection = service.selectProjectorForModel(model, secondProjector.id);

    expect(selection.model).toEqual(expect.objectContaining({
      selectedProjectorId: secondProjector.id,
      visionSource: 'user_selected_projector',
      projectorCandidates: [
        expect.objectContaining({ id: firstProjector.id }),
        expect.objectContaining({
          id: secondProjector.id,
          matchStatus: 'user_selected',
          matchReason: 'user_selected_projector',
        }),
      ],
    }));
    expect(selection.resolution).toEqual(expect.objectContaining({
      status: 'user_selected',
      reason: 'selected_projector',
      selectedProjector: expect.objectContaining({ id: secondProjector.id }),
    }));
  });
});
