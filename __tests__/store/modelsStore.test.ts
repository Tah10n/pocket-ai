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
  return {
    id: 'projector-org-model-main-mmproj-model.gguf',
    ownerModelId: 'org/model',
    repoId: 'org/model',
    fileName: 'mmproj-model.gguf',
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model.gguf',
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

    expect(selectModelProjectorLifecycleState(createModel({
      projectorCandidates: [readyProjector],
      selectedProjectorId: readyProjector.id,
    }))).toEqual(expect.objectContaining({
      status: 'downloaded',
      selectedProjector: expect.objectContaining({ id: readyProjector.id }),
      isReady: true,
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
      selectedProjectorId: projector.id,
      projectorCandidates: [projector],
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
  });
});
