import {
  useModelsStore,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  DISCOVERY_SORT,
  clearModelProjectorLocalState,
  selectModelProjectorLifecycleState,
} from '../../src/store/modelsStore';
import { storage } from '../../src/store/storage';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import type { ProjectorArtifact } from '../../src/types/multimodal';

function createProjector(overrides: Partial<ProjectorArtifact> = {}): ProjectorArtifact {
  const repoId = overrides.repoId ?? 'org/model';
  const fileName = overrides.fileName ?? 'mmproj-model.gguf';
  const hfRevision = overrides.hfRevision ?? 'main';
  return {
    id: 'projector-org-model-main-mmproj-model.gguf',
    ownerModelId: 'org/model',
    repoId,
    fileName,
    downloadUrl: `https://huggingface.co/${repoId}/resolve/${hfRevision}/${fileName}`,
    size: 1024,
    lifecycleStatus: 'available',
    matchStatus: 'matched',
    ...overrides,
  };
}

function createModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'model',
    author: 'org',
    size: 1024,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    resolvedFileName: 'model.gguf',
    fitsInRam: true,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    ...overrides,
  };
}

describe('modelsStore', () => {
  beforeEach(async () => {
    storage.remove('models-list-preferences');
    useModelsStore.setState({
      tabPreferences: {
        all: {
          filters: { ...DEFAULT_FILTERS },
          sort: { ...DEFAULT_SORT },
          discoveryMode: 'uninitialized',
        },
        downloaded: {
          filters: { ...DEFAULT_FILTERS },
          sort: { ...DEFAULT_SORT },
          discoveryMode: 'full',
        },
      },
    } as any);
    await useModelsStore.persist.rehydrate();
  });

  it('applies the guided discovery preset based on token presence', () => {
    useModelsStore.getState().applyDiscoveryPreset({ hasToken: false });

    expect(useModelsStore.getState()).toEqual(
      expect.objectContaining({
        tabPreferences: expect.objectContaining({
          all: expect.objectContaining({
            discoveryMode: 'guided',
            sort: DISCOVERY_SORT,
            filters: expect.objectContaining({
              fitsInRamOnly: true,
              noTokenRequiredOnly: true,
            }),
          }),
          downloaded: expect.objectContaining({
            filters: DEFAULT_FILTERS,
            sort: DEFAULT_SORT,
          }),
        }),
      }),
    );

    useModelsStore.getState().applyDiscoveryPreset({ hasToken: true });

    expect(useModelsStore.getState()).toEqual(
      expect.objectContaining({
        tabPreferences: expect.objectContaining({
          all: expect.objectContaining({
            discoveryMode: 'guided',
            sort: DISCOVERY_SORT,
            filters: expect.objectContaining({
              fitsInRamOnly: true,
              noTokenRequiredOnly: false,
            }),
          }),
          downloaded: expect.objectContaining({
            filters: DEFAULT_FILTERS,
            sort: DEFAULT_SORT,
          }),
        }),
      }),
    );
  });

  it('syncs token state only while in guided discovery mode', () => {
    useModelsStore.getState().showFullCatalog();
    useModelsStore.getState().syncDiscoveryTokenState(false);

    expect(useModelsStore.getState().tabPreferences.all.filters).toEqual(DEFAULT_FILTERS);

    useModelsStore.getState().applyDiscoveryPreset({ hasToken: false });
    useModelsStore.getState().syncDiscoveryTokenState(true);

    expect(useModelsStore.getState().tabPreferences.all.filters.noTokenRequiredOnly).toBe(false);
    expect(useModelsStore.getState().tabPreferences.all.sort).toEqual(DISCOVERY_SORT);
  });

  it('migrates legacy sort fields and discovery modes during rehydration', async () => {
    storage.set('models-list-preferences', JSON.stringify({
      state: {
        filters: {
          fitsInRamOnly: false,
          noTokenRequiredOnly: false,
          sizeRanges: [],
        },
        sort: {
          field: 'size',
          direction: 'asc',
        },
      },
      version: 2,
    }));

    await useModelsStore.persist.rehydrate();

    expect(useModelsStore.getState().tabPreferences.all.sort).toEqual({
      field: 'lastModified',
      direction: 'desc',
    });
    expect(useModelsStore.getState().tabPreferences.all.discoveryMode).toBe('custom');
    expect(useModelsStore.getState().tabPreferences.downloaded.filters).toEqual(DEFAULT_FILTERS);
    expect(useModelsStore.getState().tabPreferences.downloaded.sort).toEqual(DEFAULT_SORT);
  });

  it('infers custom discovery mode for pre-v3 installs with non-default preferences', async () => {
    storage.set('models-list-preferences', JSON.stringify({
      state: {
        filters: {
          fitsInRamOnly: true,
          noTokenRequiredOnly: false,
          sizeRanges: [],
        },
        sort: DEFAULT_SORT,
      },
      version: 2,
    }));

    await useModelsStore.persist.rehydrate();

    expect(useModelsStore.getState().tabPreferences.all.discoveryMode).toBe('custom');
  });

  it('stores downloaded tab preferences separately and defaults them to name + no filters', () => {
    useModelsStore.getState().applyDiscoveryPreset({ hasToken: false });

    expect(useModelsStore.getState().tabPreferences.downloaded.filters).toEqual(DEFAULT_FILTERS);
    expect(useModelsStore.getState().tabPreferences.downloaded.sort).toEqual(DEFAULT_SORT);

    useModelsStore.getState().setFitsInRamOnly('downloaded', true);

    expect(useModelsStore.getState().tabPreferences.downloaded.filters.fitsInRamOnly).toBe(true);
    expect(useModelsStore.getState().tabPreferences.downloaded.discoveryMode).toBe('custom');
    expect(useModelsStore.getState().tabPreferences.all.discoveryMode).toBe('guided');
  });

  it('selects projector lifecycle state for ready, ambiguous, and text-only models', () => {
    expect(selectModelProjectorLifecycleState(createModel()).status).toBe('text_only');

    const readyProjector = createProjector({ lifecycleStatus: 'downloaded', localPath: 'mmproj-model.gguf' });
    expect(selectModelProjectorLifecycleState(createModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: [readyProjector],
      selectedProjectorId: readyProjector.id,
    }))).toEqual(expect.objectContaining({
      status: 'downloaded',
      selectedProjector: expect.objectContaining({ id: readyProjector.id }),
      isReady: true,
      shouldPromptForChoice: false,
    }));

    expect(selectModelProjectorLifecycleState(createModel({
      chatModalities: ['text', 'audio'],
      projectorCandidates: [readyProjector],
      selectedProjectorId: readyProjector.id,
    }))).toEqual(expect.objectContaining({
      status: 'downloaded',
      selectedProjector: expect.objectContaining({ id: readyProjector.id }),
      isReady: true,
      shouldPromptForChoice: false,
    }));

    const ambiguousState = selectModelProjectorLifecycleState(createModel({
      chatModalities: ['text', 'vision'],
      projectorCandidates: [
        createProjector({ id: 'projector-a', fileName: 'mmproj-a.gguf', matchStatus: 'ambiguous' }),
        createProjector({ id: 'projector-b', fileName: 'mmproj-b.gguf', matchStatus: 'ambiguous' }),
      ],
    }));
    expect(ambiguousState).toEqual(expect.objectContaining({
      status: 'ambiguous',
      shouldPromptForChoice: true,
    }));
    expect(ambiguousState.selectedProjector).toBeUndefined();

    const audioAmbiguousState = selectModelProjectorLifecycleState(createModel({
      chatModalities: ['text', 'audio'],
      projectorCandidates: [
        createProjector({ id: 'projector-a', fileName: 'mmproj-a.gguf', matchStatus: 'ambiguous' }),
        createProjector({ id: 'projector-b', fileName: 'mmproj-b.gguf', matchStatus: 'ambiguous' }),
      ],
    }));
    expect(audioAmbiguousState).toEqual(expect.objectContaining({
      status: 'ambiguous',
      shouldPromptForChoice: true,
    }));
    expect(audioAmbiguousState.selectedProjector).toBeUndefined();

    expect(selectModelProjectorLifecycleState(createModel({
      projectorCandidates: [readyProjector],
      selectedProjectorId: readyProjector.id,
    }))).toEqual(expect.objectContaining({
      status: 'downloaded',
      selectedProjector: expect.objectContaining({ id: readyProjector.id }),
      isReady: true,
    }));
  });

  it('returns text-only lifecycle for an active text-only variant despite parent multimodal metadata', () => {
    const projector = createProjector({ lifecycleStatus: 'downloaded' });
    expect(selectModelProjectorLifecycleState(createModel({
      chatModalities: ['text', 'vision', 'audio'],
      activeVariantId: 'text-variant',
      resolvedFileName: 'text.gguf',
      variants: [{
        variantId: 'text-variant',
        fileName: 'text.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1,
        chatModalities: ['text'],
      }],
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
    }))).toEqual(expect.objectContaining({
      status: 'text_only',
      reason: 'text_only',
      candidates: [],
    }));
  });

  it('clears local projector lifecycle after model removal while preserving the selected projector', () => {
    const projector = createProjector({
      lifecycleStatus: 'active',
      localPath: 'mmproj-model.gguf',
      resumeData: 'stale-projector-resume-data',
      downloadProgress: 0.72,
      matchStatus: 'user_selected',
    });
    const clearedModel = clearModelProjectorLocalState(createModel({
      chatModalities: ['text', 'vision'],
      activeVariantId: 'model-variant',
      resolvedFileName: 'model.gguf',
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
      variants: [{
        variantId: 'model-variant',
        fileName: 'model.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 1024,
        chatModalities: ['text', 'vision'],
        selectedProjectorId: projector.id,
        projectorCandidates: [{ ...projector }],
      }],
      artifacts: [{
        id: projector.id,
        kind: 'multimodal_projector',
        requiredFor: ['image'],
        remoteFileName: projector.fileName,
        downloadUrl: projector.downloadUrl,
        sizeBytes: projector.size,
        localPath: projector.localPath,
        installState: 'installed',
        downloadProgress: 1,
        resumeData: 'stale-artifact-resume',
        integrity: { kind: 'size', sizeBytes: 1024, checkedAt: 7 },
      }],
      multimodalReadiness: {
        modelId: 'org/model',
        status: 'ready',
        support: ['vision'],
        projectorId: projector.id,
        checkedAt: 1,
      },
    }));

    expect(clearedModel.selectedProjectorId).toBe(projector.id);
    expect(clearedModel.multimodalReadiness).toBeUndefined();
    expect(clearedModel.projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: projector.id,
      lifecycleStatus: 'available',
      localPath: undefined,
      resumeData: undefined,
      downloadProgress: undefined,
      matchStatus: 'user_selected',
    }));
    expect(clearedModel.variants?.[0].selectedProjectorId).toBe(projector.id);
    expect(clearedModel.variants?.[0].projectorCandidates?.[0]).toEqual(expect.objectContaining({
      id: projector.id,
      lifecycleStatus: 'available',
      localPath: undefined,
      resumeData: undefined,
      downloadProgress: undefined,
    }));
    expect(clearedModel.artifacts?.[0]).toEqual({
      id: projector.id,
      kind: 'multimodal_projector',
      requiredFor: ['image'],
      remoteFileName: projector.fileName,
      downloadUrl: projector.downloadUrl,
      sizeBytes: projector.size,
      installState: 'remote',
    });
  });

  it('clears artifact-only projector runtime state after storage cleanup', () => {
    const projector = createProjector();
    const clearedModel = clearModelProjectorLocalState(createModel({
      artifacts: [{
        id: projector.id,
        kind: 'multimodal_projector',
        requiredFor: ['audio'],
        remoteFileName: projector.fileName,
        downloadUrl: projector.downloadUrl,
        sizeBytes: projector.size,
        localPath: 'deleted-mmproj.gguf',
        installState: 'installed',
        downloadProgress: 1,
      }],
    }));

    expect(clearedModel.artifacts?.[0]).toEqual(expect.objectContaining({
      id: projector.id,
      requiredFor: ['audio'],
      installState: 'remote',
    }));
    expect(clearedModel.artifacts?.[0]?.localPath).toBeUndefined();
    expect(clearedModel.artifacts?.[0]?.downloadProgress).toBeUndefined();
  });
});
