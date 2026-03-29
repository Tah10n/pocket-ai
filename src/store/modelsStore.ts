import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { LifecycleStatus } from '../types/models';

export type ModelSizeRange = 'small' | 'medium' | 'large';
export type ModelSortField = 'name' | 'size' | 'downloaded' | 'downloads' | 'likes';
export type ModelSortDirection = 'asc' | 'desc';
export type CatalogDiscoveryMode = 'uninitialized' | 'guided' | 'full' | 'custom';
export const MODELS_PAGE_SIZE = 10;

export interface ModelFilterCriteria {
  fitsInRamOnly: boolean;
  noTokenRequiredOnly: boolean;
  statuses: LifecycleStatus[];
  sizeRanges: ModelSizeRange[];
}

export interface ModelSortPreference {
  field: ModelSortField;
  direction: ModelSortDirection;
}

interface ModelsStoreState {
  filters: ModelFilterCriteria;
  sort: ModelSortPreference;
  discoveryMode: CatalogDiscoveryMode;
  applyDiscoveryPreset: (options: { hasToken: boolean }) => void;
  syncDiscoveryTokenState: (hasToken: boolean) => void;
  showFullCatalog: () => void;
  setFitsInRamOnly: (enabled: boolean) => void;
  setNoTokenRequiredOnly: (enabled: boolean) => void;
  toggleStatus: (status: LifecycleStatus) => void;
  toggleSizeRange: (sizeRange: ModelSizeRange) => void;
  setSort: (sort: ModelSortPreference) => void;
  clearFilters: () => void;
}

export const DEFAULT_FILTERS: ModelFilterCriteria = {
  fitsInRamOnly: false,
  noTokenRequiredOnly: false,
  statuses: [],
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
    statuses: [],
    sizeRanges: [],
  };
}

function createDiscoveryFilters(hasToken: boolean): ModelFilterCriteria {
  return {
    fitsInRamOnly: true,
    noTokenRequiredOnly: !hasToken,
    statuses: [],
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
    || value === 'size'
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
    statuses: Array.isArray(source.statuses)
      ? source.statuses.filter((status): status is LifecycleStatus => (
          Object.values(LifecycleStatus).includes(status as LifecycleStatus)
        ))
      : [],
    sizeRanges: Array.isArray(source.sizeRanges)
      ? source.sizeRanges.filter(isModelSizeRange)
      : [],
  };
}

function normalizeSort(sort: unknown): ModelSortPreference {
  const source = (sort ?? {}) as Partial<ModelSortPreference>;
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
    || filters.statuses.length > 0
    || filters.sizeRanges.length > 0
    || sort.field !== DEFAULT_SORT.field
    || sort.direction !== DEFAULT_SORT.direction
  );
}

export const useModelsStore = create<ModelsStoreState>()(
  persist(
    (set) => ({
      filters: createDefaultFilters(),
      sort: DEFAULT_SORT,
      discoveryMode: 'uninitialized',

      applyDiscoveryPreset: ({ hasToken }) =>
        set({
          filters: createDiscoveryFilters(hasToken),
          sort: DISCOVERY_SORT,
          discoveryMode: 'guided',
        }),

      syncDiscoveryTokenState: (hasToken) =>
        set((state) => {
          if (state.discoveryMode !== 'guided') {
            return state;
          }

          const nextFilters = createDiscoveryFilters(hasToken);
          const noFilterChange =
            state.filters.fitsInRamOnly === nextFilters.fitsInRamOnly
            && state.filters.noTokenRequiredOnly === nextFilters.noTokenRequiredOnly
            && state.filters.statuses.length === 0
            && state.filters.sizeRanges.length === 0;
          const noSortChange =
            state.sort.field === DISCOVERY_SORT.field
            && state.sort.direction === DISCOVERY_SORT.direction;

          if (noFilterChange && noSortChange) {
            return state;
          }

          return {
            filters: nextFilters,
            sort: DISCOVERY_SORT,
          };
        }),

      showFullCatalog: () =>
        set((state) => ({
          filters: createDefaultFilters(),
          sort: state.sort,
          discoveryMode: 'full',
        })),

      setFitsInRamOnly: (enabled) =>
        set((state) => ({
          filters: { ...state.filters, fitsInRamOnly: enabled },
          discoveryMode: 'custom',
        })),

      setNoTokenRequiredOnly: (enabled) =>
        set((state) => ({
          filters: { ...state.filters, noTokenRequiredOnly: enabled },
          discoveryMode: 'custom',
        })),

      toggleStatus: (status) =>
        set((state) => ({
          filters: {
            ...state.filters,
            statuses: toggleValue(state.filters.statuses, status),
          },
          discoveryMode: 'custom',
        })),

      toggleSizeRange: (sizeRange) =>
        set((state) => ({
          filters: {
            ...state.filters,
            sizeRanges: toggleValue(state.filters.sizeRanges, sizeRange),
          },
          discoveryMode: 'custom',
        })),

      setSort: (sort) =>
        set({
          sort,
          discoveryMode: 'custom',
        }),

      clearFilters: () =>
        set((state) => ({
          filters: createDefaultFilters(),
          sort: state.sort,
          discoveryMode: 'full',
        })),
    }),
    {
      name: 'models-list-preferences',
      version: 2,
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({
        filters: state.filters,
        sort: state.sort,
        discoveryMode: state.discoveryMode,
      }),
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<ModelsStoreState>;
        const filters = normalizeFilters(state.filters);
        const sort = normalizeSort(state.sort);
        const discoveryMode = normalizeDiscoveryMode(state.discoveryMode)
          ?? (hasNonDefaultPreferences(filters, sort) ? 'custom' : 'uninitialized');

        return {
          ...state,
          filters,
          sort,
          discoveryMode,
        };
      },
    },
  ),
);
