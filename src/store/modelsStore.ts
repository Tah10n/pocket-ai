import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import type { ModelsCatalogTab } from './modelsCatalogTabs';

export type ModelSizeRange = 'small' | 'medium' | 'large';
export type ModelSortField = 'name' | 'lastModified' | 'downloaded' | 'downloads' | 'likes';
export type ModelSortDirection = 'asc' | 'desc';
export type CatalogDiscoveryMode = 'uninitialized' | 'guided' | 'full' | 'custom';
export type ModelsCatalogTabId = ModelsCatalogTab;
export const MODELS_PAGE_SIZE = 20;

export interface ModelFilterCriteria {
  fitsInRamOnly: boolean;
  noTokenRequiredOnly: boolean;
  sizeRanges: ModelSizeRange[];
}

export interface ModelSortPreference {
  field: ModelSortField;
  direction: ModelSortDirection;
}

export interface ModelsCatalogTabPreferences {
  filters: ModelFilterCriteria;
  sort: ModelSortPreference;
  discoveryMode: CatalogDiscoveryMode;
}

interface ModelsStoreState {
  tabPreferences: Record<ModelsCatalogTabId, ModelsCatalogTabPreferences>;
  applyDiscoveryPreset: (options: { hasToken: boolean }) => void;
  syncDiscoveryTokenState: (hasToken: boolean) => void;
  showFullCatalog: () => void;
  setFitsInRamOnly: (tab: ModelsCatalogTabId, enabled: boolean) => void;
  setNoTokenRequiredOnly: (tab: ModelsCatalogTabId, enabled: boolean) => void;
  toggleSizeRange: (tab: ModelsCatalogTabId, sizeRange: ModelSizeRange) => void;
  setSort: (tab: ModelsCatalogTabId, sort: ModelSortPreference) => void;
  clearFilters: (tab: ModelsCatalogTabId) => void;
}

export const DEFAULT_FILTERS: ModelFilterCriteria = {
  fitsInRamOnly: false,
  noTokenRequiredOnly: false,
  sizeRanges: [],
};

export const DEFAULT_SORT: ModelSortPreference = {
  field: 'name',
  direction: 'asc',
};

export const DISCOVERY_SORT: ModelSortPreference = {
  field: 'downloads',
  direction: 'desc',
};

function createDefaultFilters(): ModelFilterCriteria {
  return {
    fitsInRamOnly: false,
    noTokenRequiredOnly: false,
    sizeRanges: [],
  };
}

function createDiscoveryFilters(hasToken: boolean): ModelFilterCriteria {
  return {
    fitsInRamOnly: true,
    noTokenRequiredOnly: !hasToken,
    sizeRanges: [],
  };
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

function isModelSizeRange(value: unknown): value is ModelSizeRange {
  return value === 'small' || value === 'medium' || value === 'large';
}

function isModelSortField(value: unknown): value is ModelSortField {
  return value === 'name'
    || value === 'lastModified'
    || value === 'downloaded'
    || value === 'downloads'
    || value === 'likes';
}

function isModelSortDirection(value: unknown): value is ModelSortDirection {
  return value === 'asc' || value === 'desc';
}

function normalizeFilters(filters: unknown): ModelFilterCriteria {
  const source = (filters ?? {}) as Partial<ModelFilterCriteria>;
  return {
    fitsInRamOnly: source.fitsInRamOnly === true,
    noTokenRequiredOnly: source.noTokenRequiredOnly === true,
    sizeRanges: Array.isArray(source.sizeRanges)
      ? source.sizeRanges.filter(isModelSizeRange)
      : [],
  };
}

function normalizeSort(sort: unknown): ModelSortPreference {
  const source = (sort ?? {}) as { field?: unknown; direction?: unknown };

  if (source.field === 'size') {
    return {
      field: 'lastModified',
      direction: 'desc',
    };
  }

  return {
    field: isModelSortField(source.field) ? source.field : DEFAULT_SORT.field,
    direction: isModelSortDirection(source.direction) ? source.direction : DEFAULT_SORT.direction,
  };
}

function normalizeDiscoveryMode(value: unknown): CatalogDiscoveryMode | undefined {
  return value === 'uninitialized'
    || value === 'guided'
    || value === 'full'
    || value === 'custom'
    ? value
    : undefined;
}

function hasNonDefaultPreferences(
  filters: ModelFilterCriteria,
  sort: ModelSortPreference,
): boolean {
  return (
    filters.fitsInRamOnly
    || filters.noTokenRequiredOnly
    || filters.sizeRanges.length > 0
    || sort.field !== DEFAULT_SORT.field
    || sort.direction !== DEFAULT_SORT.direction
  );
}

function resolvePersistedDiscoveryMode(
  previousVersion: number,
  persistedDiscoveryMode: CatalogDiscoveryMode | undefined,
  filters: ModelFilterCriteria,
  sort: ModelSortPreference,
): CatalogDiscoveryMode {
  return previousVersion < 3
    ? (
      persistedDiscoveryMode === 'guided' || persistedDiscoveryMode === 'full'
        ? persistedDiscoveryMode
        : hasNonDefaultPreferences(filters, sort)
          ? 'custom'
          : 'uninitialized'
    )
    : persistedDiscoveryMode
      ?? (hasNonDefaultPreferences(filters, sort) ? 'custom' : 'uninitialized');
}

export const useModelsStore = create<ModelsStoreState>()(
  persist(
    (set) => ({
      tabPreferences: {
        all: {
          filters: createDefaultFilters(),
          sort: DEFAULT_SORT,
          discoveryMode: 'uninitialized',
        },
        downloaded: {
          filters: createDefaultFilters(),
          sort: DEFAULT_SORT,
          discoveryMode: 'full',
        },
      },

      applyDiscoveryPreset: ({ hasToken }) =>
        set((state) => ({
          tabPreferences: {
            ...state.tabPreferences,
            all: {
              filters: createDiscoveryFilters(hasToken),
              sort: DISCOVERY_SORT,
              discoveryMode: 'guided',
            },
          },
        })),

      syncDiscoveryTokenState: (hasToken) =>
        set((state) => {
          const allPreferences = state.tabPreferences.all;
          if (allPreferences.discoveryMode !== 'guided') {
            return state;
          }

          const nextFilters = createDiscoveryFilters(hasToken);
          const noFilterChange =
            allPreferences.filters.fitsInRamOnly === nextFilters.fitsInRamOnly
            && allPreferences.filters.noTokenRequiredOnly === nextFilters.noTokenRequiredOnly
            && allPreferences.filters.sizeRanges.length === 0;
          const noSortChange =
            allPreferences.sort.field === DISCOVERY_SORT.field
            && allPreferences.sort.direction === DISCOVERY_SORT.direction;

          if (noFilterChange && noSortChange) {
            return state;
          }

          return {
            tabPreferences: {
              ...state.tabPreferences,
              all: {
                ...allPreferences,
                filters: nextFilters,
                sort: DISCOVERY_SORT,
              },
            },
          };
        }),

      showFullCatalog: () =>
        set((state) => ({
          tabPreferences: {
            ...state.tabPreferences,
            all: {
              ...state.tabPreferences.all,
              filters: createDefaultFilters(),
              discoveryMode: 'full',
            },
          },
        })),

      setFitsInRamOnly: (tab, enabled) =>
        set((state) => ({
          tabPreferences: {
            ...state.tabPreferences,
            [tab]: {
              ...state.tabPreferences[tab],
              filters: { ...state.tabPreferences[tab].filters, fitsInRamOnly: enabled },
              discoveryMode: 'custom',
            },
          },
        })),

      setNoTokenRequiredOnly: (tab, enabled) =>
        set((state) => ({
          tabPreferences: {
            ...state.tabPreferences,
            [tab]: {
              ...state.tabPreferences[tab],
              filters: { ...state.tabPreferences[tab].filters, noTokenRequiredOnly: enabled },
              discoveryMode: 'custom',
            },
          },
        })),

      toggleSizeRange: (tab, sizeRange) =>
        set((state) => ({
          tabPreferences: {
            ...state.tabPreferences,
            [tab]: {
              ...state.tabPreferences[tab],
              filters: {
                ...state.tabPreferences[tab].filters,
                sizeRanges: toggleValue(state.tabPreferences[tab].filters.sizeRanges, sizeRange),
              },
              discoveryMode: 'custom',
            },
          },
        })),

      setSort: (tab, sort) =>
        set((state) => ({
          tabPreferences: {
            ...state.tabPreferences,
            [tab]: {
              ...state.tabPreferences[tab],
              sort,
              discoveryMode: 'custom',
            },
          },
        })),

      clearFilters: (tab) =>
        set((state) => ({
          tabPreferences: {
            ...state.tabPreferences,
            [tab]: {
              ...state.tabPreferences[tab],
              filters: createDefaultFilters(),
              discoveryMode: 'full',
            },
          },
        })),
    }),
    {
      name: 'models-list-preferences',
      version: 6,
      skipHydration: true,
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({ tabPreferences: state.tabPreferences }),
      merge: (persistedState, currentState) => {
        const state = (persistedState ?? {}) as Partial<ModelsStoreState> & {
          tabPreferences?: unknown;
        };
        const persistedPreferences = (state.tabPreferences ?? {}) as Partial<Record<
          ModelsCatalogTabId,
          Partial<ModelsCatalogTabPreferences>
        >>;

        const allFilters = normalizeFilters(
          persistedPreferences.all?.filters ?? currentState.tabPreferences.all.filters,
        );
        const allSort = normalizeSort(
          persistedPreferences.all?.sort ?? currentState.tabPreferences.all.sort,
        );
        const allDiscoveryMode = normalizeDiscoveryMode(persistedPreferences.all?.discoveryMode)
          ?? (hasNonDefaultPreferences(allFilters, allSort) ? 'custom' : currentState.tabPreferences.all.discoveryMode);

        const downloadedFilters = normalizeFilters(
          persistedPreferences.downloaded?.filters ?? currentState.tabPreferences.downloaded.filters,
        );
        const downloadedSort = normalizeSort(
          persistedPreferences.downloaded?.sort ?? currentState.tabPreferences.downloaded.sort,
        );
        const downloadedDiscoveryMode = normalizeDiscoveryMode(persistedPreferences.downloaded?.discoveryMode)
          ?? (hasNonDefaultPreferences(downloadedFilters, downloadedSort) ? 'custom' : currentState.tabPreferences.downloaded.discoveryMode);

        return {
          ...currentState,
          ...state,
          tabPreferences: {
            all: {
              filters: allFilters,
              sort: allSort,
              discoveryMode: allDiscoveryMode,
            },
            downloaded: {
              filters: downloadedFilters,
              sort: downloadedSort,
              discoveryMode: downloadedDiscoveryMode,
            },
          },
        };
      },
      migrate: (persistedState, version) => {
        const previousVersion = typeof version === 'number' ? version : 0;
        const state = (persistedState ?? {}) as any;

        const legacyFilters = normalizeFilters(state.filters);
        const legacySort = normalizeSort(state.sort);
        const legacyDiscoveryMode = resolvePersistedDiscoveryMode(
          previousVersion,
          normalizeDiscoveryMode(state.discoveryMode),
          legacyFilters,
          legacySort,
        );

        const persistedPreferences = state.tabPreferences as ModelsStoreState['tabPreferences'] | undefined;
        const allSource = previousVersion >= 5 ? persistedPreferences?.all : undefined;
        const downloadedSource = previousVersion >= 5 ? persistedPreferences?.downloaded : undefined;

        const allFilters = normalizeFilters(allSource?.filters ?? legacyFilters);
        const allSort = normalizeSort(allSource?.sort ?? legacySort);
        const allPersistedDiscoveryMode = normalizeDiscoveryMode(allSource?.discoveryMode ?? legacyDiscoveryMode);
        const allDiscoveryMode = resolvePersistedDiscoveryMode(
          previousVersion,
          allPersistedDiscoveryMode,
          allFilters,
          allSort,
        );

        const downloadedFilters = previousVersion >= 5
          ? normalizeFilters(downloadedSource?.filters)
          : createDefaultFilters();
        const downloadedSort = previousVersion >= 5
          ? normalizeSort(downloadedSource?.sort)
          : DEFAULT_SORT;
        const downloadedDiscoveryMode = previousVersion >= 5
          ? (
            normalizeDiscoveryMode(downloadedSource?.discoveryMode)
              ?? (hasNonDefaultPreferences(downloadedFilters, downloadedSort) ? 'custom' : 'full')
          )
          : 'full';

        return {
          tabPreferences: {
            all: {
              filters: allFilters,
              sort: allSort,
              discoveryMode: allDiscoveryMode,
            },
            downloaded: {
              filters: downloadedFilters,
              sort: downloadedSort,
              discoveryMode: downloadedDiscoveryMode,
            },
          },
        };
      },
    },
  ),
);
