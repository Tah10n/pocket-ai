import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStorage } from '../lib/mmkv';
import { LifecycleStatus } from '../types/models';

export type ModelSizeRange = 'small' | 'medium' | 'large';
export type ModelSortField = 'name' | 'size' | 'downloaded';
export type ModelSortDirection = 'asc' | 'desc';

export interface ModelFilterCriteria {
  fitsInRamOnly: boolean;
  statuses: LifecycleStatus[];
  sizeRanges: ModelSizeRange[];
}

export interface ModelSortPreference {
  field: ModelSortField;
  direction: ModelSortDirection;
}

export interface PaginationState {
  page: number;
  pageSize: number;
}

interface ModelsStoreState {
  filters: ModelFilterCriteria;
  sort: ModelSortPreference;
  pagination: PaginationState;
  setFitsInRamOnly: (enabled: boolean) => void;
  toggleStatus: (status: LifecycleStatus) => void;
  toggleSizeRange: (sizeRange: ModelSizeRange) => void;
  setSort: (sort: ModelSortPreference) => void;
  clearFilters: () => void;
  resetPagination: () => void;
  fetchNextPage: () => void;
  setPage: (page: number) => void;
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

const DEFAULT_PAGINATION: PaginationState = {
  page: 0,
  pageSize: 10,
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
      pagination: DEFAULT_PAGINATION,

      setFitsInRamOnly: (enabled) =>
        set((state) => ({
          filters: { ...state.filters, fitsInRamOnly: enabled },
          pagination: DEFAULT_PAGINATION,
        })),

      toggleStatus: (status) =>
        set((state) => ({
          filters: {
            ...state.filters,
            statuses: toggleValue(state.filters.statuses, status),
          },
          pagination: DEFAULT_PAGINATION,
        })),

      toggleSizeRange: (sizeRange) =>
        set((state) => ({
          filters: {
            ...state.filters,
            sizeRanges: toggleValue(state.filters.sizeRanges, sizeRange),
          },
          pagination: DEFAULT_PAGINATION,
        })),

      setSort: (sort) =>
        set({
          sort,
          pagination: DEFAULT_PAGINATION,
        }),

      clearFilters: () =>
        set((state) => ({
          filters: DEFAULT_FILTERS,
          sort: state.sort,
          pagination: DEFAULT_PAGINATION,
        })),

      resetPagination: () =>
        set({
          pagination: DEFAULT_PAGINATION,
        }),

      fetchNextPage: () =>
        set((state) => ({
          pagination: {
            ...state.pagination,
            page: state.pagination.page + 1,
          },
        })),

      setPage: (page) =>
        set((state) => ({
          pagination: {
            ...state.pagination,
            page,
          },
        })),
    }),
    {
      name: 'models-list-preferences',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({
        filters: state.filters,
        sort: state.sort,
        pagination: state.pagination,
      }),
    },
  ),
);
