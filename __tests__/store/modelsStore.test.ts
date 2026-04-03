import { useModelsStore, DEFAULT_FILTERS, DEFAULT_SORT, DISCOVERY_SORT } from '../../src/store/modelsStore';
import { storage } from '../../src/store/storage';

describe('modelsStore', () => {
  beforeEach(async () => {
    storage.remove('models-list-preferences');
    useModelsStore.setState({
      filters: { ...DEFAULT_FILTERS },
      sort: { ...DEFAULT_SORT },
      discoveryMode: 'uninitialized',
    } as any);
    await useModelsStore.persist.rehydrate();
  });

  it('applies the guided discovery preset based on token presence', () => {
    useModelsStore.getState().applyDiscoveryPreset({ hasToken: false });

    expect(useModelsStore.getState()).toEqual(
      expect.objectContaining({
        discoveryMode: 'guided',
        sort: DISCOVERY_SORT,
        filters: expect.objectContaining({
          fitsInRamOnly: true,
          noTokenRequiredOnly: true,
        }),
      }),
    );

    useModelsStore.getState().applyDiscoveryPreset({ hasToken: true });

    expect(useModelsStore.getState()).toEqual(
      expect.objectContaining({
        discoveryMode: 'guided',
        sort: DISCOVERY_SORT,
        filters: expect.objectContaining({
          fitsInRamOnly: true,
          noTokenRequiredOnly: false,
        }),
      }),
    );
  });

  it('syncs token state only while in guided discovery mode', () => {
    useModelsStore.getState().showFullCatalog();
    useModelsStore.getState().syncDiscoveryTokenState(false);

    expect(useModelsStore.getState().filters).toEqual(DEFAULT_FILTERS);

    useModelsStore.getState().applyDiscoveryPreset({ hasToken: false });
    useModelsStore.getState().syncDiscoveryTokenState(true);

    expect(useModelsStore.getState().filters.noTokenRequiredOnly).toBe(false);
    expect(useModelsStore.getState().sort).toEqual(DISCOVERY_SORT);
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

    expect(useModelsStore.getState().sort).toEqual({
      field: 'lastModified',
      direction: 'desc',
    });
    expect(useModelsStore.getState().discoveryMode).toBe('custom');
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

    expect(useModelsStore.getState().discoveryMode).toBe('custom');
  });
});
