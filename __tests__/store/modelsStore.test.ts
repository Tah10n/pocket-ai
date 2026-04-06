import { useModelsStore, DEFAULT_FILTERS, DEFAULT_SORT, DISCOVERY_SORT } from '../../src/store/modelsStore';
import { storage } from '../../src/store/storage';

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
});
