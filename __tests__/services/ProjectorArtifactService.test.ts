import { ProjectorArtifactService } from '../../src/services/ProjectorArtifactService';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';
import {
  alternateProjectorFileName,
  projectorFileName,
  visionModelFileName,
  visionModelRepoId,
} from '../fixtures/multimodalCatalogFixtures';
import {
  buildLegacyProjectorArtifactId,
  buildProjectorArtifactId,
} from '../../src/utils/modelProjectors';
import { resolveEffectiveActiveVariantNativeSupport } from '../../src/utils/modelCapabilities';

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

  it('keeps variant-scoped projector candidates when active variant scope is unavailable', () => {
    const projector = createProjector(projectorFileName);
    const service = new ProjectorArtifactService();

    expect(service.resolveProjectorForModel(createVisionModel({
      activeVariantId: undefined,
      resolvedFileName: undefined,
      variants: undefined,
      projectorCandidates: [projector],
    }))).toEqual(expect.objectContaining({
      status: 'matched',
      reason: 'single_projector_candidate',
      selectedProjector: expect.objectContaining({ id: projector.id }),
    }));
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

  it('preserves projector-scoped memory fit when selecting an explicit id for the same effective artifact', () => {
    const projectorSha = 'd'.repeat(64);
    const implicitProjector = createProjector(projectorFileName, {
      id: 'legacy-projector-id',
      sha256: projectorSha,
      size: 512,
      matchStatus: 'matched',
    });
    const explicitProjector = createProjector(projectorFileName, {
      id: 'current-projector-id',
      sha256: projectorSha,
      size: 512,
      matchStatus: 'ambiguous',
    });
    const service = new ProjectorArtifactService();

    const selection = service.selectProjectorForModel(createVisionModel({
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      variants: [{
        variantId: visionModelFileName,
        fileName: visionModelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        ramFit: 'fits_high_confidence',
        ramFitConfidence: 'high',
      }],
      projectorCandidates: [implicitProjector, explicitProjector],
    }), explicitProjector.id);
    const canonicalProjectorId = buildProjectorArtifactId(explicitProjector);

    expect(selection.model).toEqual(expect.objectContaining({
      selectedProjectorId: canonicalProjectorId,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      variants: [expect.objectContaining({
        ramFit: 'fits_high_confidence',
        ramFitConfidence: 'high',
      })],
    }));
  });

  it('clears projector-scoped memory fit when selected projector artifact size changes', () => {
    const firstProjector = createProjector(projectorFileName, {
      size: 512,
      matchStatus: 'user_selected',
    });
    const secondProjector = createProjector(alternateProjectorFileName, {
      size: 1024,
      matchStatus: 'ambiguous',
    });
    const service = new ProjectorArtifactService();

    const selection = service.selectProjectorForModel(createVisionModel({
      selectedProjectorId: firstProjector.id,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      variants: [{
        variantId: visionModelFileName,
        fileName: visionModelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        ramFit: 'fits_high_confidence',
        ramFitConfidence: 'high',
      }],
      projectorCandidates: [firstProjector, secondProjector],
    }), secondProjector.id);

    expect(selection.model).toEqual(expect.objectContaining({
      selectedProjectorId: secondProjector.id,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
      variants: [expect.objectContaining({
        ramFit: undefined,
        ramFitConfidence: undefined,
      })],
    }));
  });

  it.each(['current-first', 'legacy-first'] as const)(
    'collapses current and legacy aliases before projector selection (%s)',
    (order) => {
      const currentProjector = createProjector(projectorFileName);
      const legacyProjector = {
        ...currentProjector,
        id: buildLegacyProjectorArtifactId(currentProjector),
        localPath: 'legacy-mmproj.gguf',
        lifecycleStatus: 'downloaded' as const,
      };
      const projectorCandidates = order === 'current-first'
        ? [currentProjector, legacyProjector]
        : [legacyProjector, currentProjector];
      const model = createVisionModel({ projectorCandidates });
      const service = new ProjectorArtifactService();

      expect(service.resolveProjectorForModel(model)).toEqual(expect.objectContaining({
        status: 'matched',
        reason: 'single_projector_candidate',
        selectedProjector: expect.objectContaining({
          id: currentProjector.id,
          localPath: legacyProjector.localPath,
          lifecycleStatus: 'downloaded',
        }),
      }));
      expect(service.selectProjectorForModel(model, legacyProjector.id).model)
        .toEqual(expect.objectContaining({ selectedProjectorId: currentProjector.id }));
    },
  );

  it('clears projector-scoped memory fit when the active variant owns the previous selection', () => {
    const firstProjector = createProjector(projectorFileName, {
      size: 512 * 1024 * 1024,
      matchStatus: 'user_selected',
    });
    const secondProjector = createProjector(alternateProjectorFileName, {
      size: 4 * 1024 * 1024 * 1024,
      matchStatus: 'ambiguous',
    });
    const service = new ProjectorArtifactService();
    const model = createVisionModel({
      selectedProjectorId: firstProjector.id,
      fitsInRam: true,
      memoryFitDecision: 'fits_high_confidence',
      memoryFitConfidence: 'high',
      projectorCandidates: [firstProjector, secondProjector],
      variants: [{
        variantId: visionModelFileName,
        fileName: visionModelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        ramFit: 'fits_high_confidence',
        ramFitConfidence: 'high',
        selectedProjectorId: firstProjector.id,
        projectorCandidates: [firstProjector, secondProjector],
      }],
    });

    const selection = service.selectProjectorForModel(model, secondProjector.id);

    expect(selection.model).toEqual(expect.objectContaining({
      selectedProjectorId: secondProjector.id,
      fitsInRam: null,
      memoryFitDecision: undefined,
      memoryFitConfidence: undefined,
      variants: [expect.objectContaining({
        selectedProjectorId: secondProjector.id,
        ramFit: undefined,
        ramFitConfidence: undefined,
      })],
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

  it.each([
    {
      label: 'another variant',
      readiness: {
        variantId: 'vision-chat-model-Q8_0.gguf',
        requestedSupport: ['vision'] as Array<'vision' | 'audio'>,
      },
    },
    {
      label: 'another requested modality set',
      readiness: {
        variantId: visionModelFileName,
        requestedSupport: ['vision', 'audio'] as Array<'vision' | 'audio'>,
      },
    },
  ])('clears readiness from $label when reselecting the same projector', ({ readiness }) => {
    const projector = createProjector(projectorFileName, { matchStatus: 'user_selected' });
    const model = createVisionModel({
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
      multimodalReadiness: {
        modelId: visionModelRepoId,
        status: 'ready',
        projectorId: projector.id,
        support: ['vision'],
        checkedAt: 123,
        ...readiness,
      },
    });
    const service = new ProjectorArtifactService();

    const selection = service.selectProjectorForModel(model, projector.id);

    expect(selection.model).toEqual(expect.objectContaining({
      selectedProjectorId: projector.id,
      multimodalReadiness: undefined,
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

  it('does not write vision provenance when selecting an audio-only active variant projector', () => {
    const audioProjector = createProjector('mmproj-audio-model-f16.gguf');
    const model = createVisionModel({
      visionSource: 'catalog_metadata',
      visionConfidence: 'trusted',
      variants: [{
        variantId: visionModelFileName,
        fileName: visionModelFileName,
        quantizationLabel: 'Q4_K_M',
        size: 4_000_000_000,
        chatModalities: ['text', 'audio'],
        projectorCandidates: [audioProjector],
      }],
      projectorCandidates: [audioProjector],
    });
    const service = new ProjectorArtifactService();

    const selection = service.selectProjectorForModel(model, audioProjector.id);

    expect(selection.model).toEqual(expect.objectContaining({
      selectedProjectorId: audioProjector.id,
      visionSource: undefined,
      visionConfidence: undefined,
      variants: [expect.objectContaining({
        selectedProjectorId: audioProjector.id,
        visionSource: undefined,
        visionConfidence: undefined,
        projectorCandidates: [expect.objectContaining({
          id: audioProjector.id,
          matchStatus: 'user_selected',
        })],
      })],
    }));
    expect(selection.model && resolveEffectiveActiveVariantNativeSupport(selection.model)).toEqual({
      vision: false,
      audio: true,
    });
  });
});
