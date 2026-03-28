import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { LifecycleStatus } from '../types/models';

export type ModelSizeRange = 'small' | 'medium' | 'large';
export type ModelSortField = 'name' | 'size' | 'downloaded';
export type ModelSortDirection = 'asc' | 'desc';
export const MODELS_PAGE_SIZE = 10;

export interface ModelFilterCriteria {
  fitsInRamOnly: boolean;
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
  setFitsInRamOnly: (enabled: boolean) => void;
  toggleStatus: (status: LifecycleStatus) => void;
  toggleSizeRange: (sizeRange: ModelSizeRange) => void;
  setSort: (sort: ModelSortPreference) => void;
  clearFilters: () => void;
}

const DEFAULT_FILTERS: ModelFilterCriteria = {
  fitsInRamOnly: false,
  statuses: [],
  sizeRanges: [],
};

const DEFAULT_SORT: ModelSortPreference = {
  field: 'name',
  direction: 'asc',
};

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

export const useModelsStore = create<ModelsStoreState>()(
  persist(
    (set) => ({
      filters: DEFAULT_FILTERS,
      sort: DEFAULT_SORT,

      setFitsInRamOnly: (enabled) =>
        set((state) => ({
          filters: { ...state.filters, fitsInRamOnly: enabled },
        })),

      toggleStatus: (status) =>
        set((state) => ({
          filters: {
            ...state.filters,
            statuses: toggleValue(state.filters.statuses, status),
          },
        })),

      toggleSizeRange: (sizeRange) =>
        set((state) => ({
          filters: {
            ...state.filters,
            sizeRanges: toggleValue(state.filters.sizeRanges, sizeRange),
          },
        })),

      setSort: (sort) =>
        set({
          sort,
        }),

      clearFilters: () =>
        set((state) => ({
          filters: DEFAULT_FILTERS,
          sort: state.sort,
        })),
    }),
    {
      name: 'models-list-preferences',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({
        filters: state.filters,
        sort: state.sort,
      }),
    },
  ),
);
