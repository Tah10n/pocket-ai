import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { LifecycleStatus } from '@/types/models';
import { ModelFilterCriteria, ModelSizeRange, ModelSortField, ModelSortPreference } from '@/store/modelsStore';

interface ModelsFilterProps {
  filters: ModelFilterCriteria;
  sort: ModelSortPreference;
  onFitsInRamToggle: (enabled: boolean) => void;
  onStatusToggle: (status: LifecycleStatus) => void;
  onSizeRangeToggle: (sizeRange: ModelSizeRange) => void;
  onSortChange: (sort: ModelSortPreference) => void;
  onClear: () => void;
  showStatusFilters: boolean;
}

type OpenPanel = 'filter' | 'sort' | null;

type TriggerButtonProps = {
  testID: string;
  iconName: string;
  label: string;
  summary?: string;
  badge?: string;
  isOpen: boolean;
  onPress: () => void;
};

type OptionRowProps = {
  testID: string;
  label: string;
  active: boolean;
  onPress: () => void;
  trailingLabel?: string;
};

const STATUS_OPTIONS: { labelKey: string; value: LifecycleStatus }[] = [
  { labelKey: 'models.filterAvailable', value: LifecycleStatus.AVAILABLE },
  { labelKey: 'models.filterDownloading', value: LifecycleStatus.DOWNLOADING },
  { labelKey: 'models.filterDownloaded', value: LifecycleStatus.DOWNLOADED },
];

const SIZE_OPTIONS: { label: string; value: ModelSizeRange }[] = [
  { label: '< 2 GB', value: 'small' },
  { label: '2-5 GB', value: 'medium' },
  { label: '> 5 GB', value: 'large' },
];

const SORT_OPTIONS: { labelKey: string; field: ModelSortField }[] = [
  { labelKey: 'models.sortName', field: 'name' },
  { labelKey: 'models.sortSize', field: 'size' },
  { labelKey: 'models.sortDownloadedFirst', field: 'downloaded' },
];

function TriggerButton({
  testID,
  iconName,
  label,
  summary,
  badge,
  isOpen,
  onPress,
}: TriggerButtonProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      className={`min-w-0 flex-1 flex-row items-center justify-between rounded-2xl border px-3 py-2.5 active:opacity-80 ${
        isOpen
          ? 'border-primary-500 bg-primary-500/10'
          : 'border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900/60'
      }`}
    >
      <Box className="min-w-0 flex-1 flex-row items-center gap-2">
        <MaterialSymbols
          name={iconName}
          size={18}
          className={isOpen ? 'text-primary-500' : 'text-typography-500 dark:text-typography-400'}
        />
        <Text className="shrink font-semibold text-sm text-typography-900 dark:text-typography-100">
          {label}
        </Text>
        {summary ? (
          <Text
            numberOfLines={1}
            className="min-w-0 shrink text-2xs text-typography-500 dark:text-typography-400"
          >
            {summary}
          </Text>
        ) : null}
      </Box>

      <Box className="ml-2 flex-row items-center gap-1.5">
        {badge ? (
          <Box className="rounded-full bg-primary-500 px-1.5 py-0.5">
            <Text className="text-[10px] font-semibold text-typography-0">{badge}</Text>
          </Box>
        ) : null}
        <MaterialSymbols
          name={isOpen ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
          size={18}
          className={isOpen ? 'text-primary-500' : 'text-typography-500 dark:text-typography-400'}
        />
      </Box>
    </Pressable>
  );
}

function OptionRow({
  testID,
  label,
  active,
  onPress,
  trailingLabel,
}: OptionRowProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      className={`flex-row items-center justify-between rounded-xl px-3 py-2.5 active:opacity-80 ${
        active ? 'bg-primary-500/10' : 'bg-background-50/60 dark:bg-background-900/40'
      }`}
    >
      <Box className="min-w-0 flex-1 flex-row items-center gap-2.5">
        <Box className={`h-5 w-5 items-center justify-center rounded-full border ${
          active
            ? 'border-primary-500 bg-primary-500'
            : 'border-outline-300 bg-background-0 dark:border-outline-700 dark:bg-background-950'
        }`}
        >
          {active ? (
            <MaterialSymbols name="check" size={12} className="text-typography-0" />
          ) : null}
        </Box>
        <Text className="shrink text-sm text-typography-800 dark:text-typography-100">{label}</Text>
      </Box>

      {trailingLabel ? (
        <Text className="ml-3 text-2xs font-semibold text-typography-500 dark:text-typography-400">
          {trailingLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

function getActiveFilterCount(filters: ModelFilterCriteria) {
  return (
    (filters.fitsInRamOnly ? 1 : 0)
    + filters.statuses.length
    + filters.sizeRanges.length
  );
}

function getSortSummary(t: (key: string) => string, sort: ModelSortPreference) {
  const activeOption = SORT_OPTIONS.find((option) => option.field === sort.field);
  if (!activeOption) {
    return '';
  }

  if (sort.field === 'downloaded') {
    return t(activeOption.labelKey);
  }

  return `${t(activeOption.labelKey)} ${sort.direction === 'asc' ? '↑' : '↓'}`;
}

export const ModelsFilter = ({
  filters,
  sort,
  onFitsInRamToggle,
  onStatusToggle,
  onSizeRangeToggle,
  onSortChange,
  onClear,
  showStatusFilters,
}: ModelsFilterProps) => {
  const { t } = useTranslation();
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const activeFilterCount = getActiveFilterCount(filters);
  const hasActiveFilters = activeFilterCount > 0;
  const sortSummary = getSortSummary(t, sort);

  return (
    <Box className="border-b border-outline-200 bg-background-0 px-4 py-2 dark:border-outline-800 dark:bg-background-950">
      <Box className="flex-row gap-2">
        <TriggerButton
          testID="models-filter-toggle"
          iconName="filter-list"
          label={t('models.filtersTitle')}
          badge={hasActiveFilters ? String(activeFilterCount) : undefined}
          isOpen={openPanel === 'filter'}
          onPress={() => {
            setOpenPanel((current) => current === 'filter' ? null : 'filter');
          }}
        />
        <TriggerButton
          testID="models-sort-toggle"
          iconName="sort"
          label={t('models.sortTitle')}
          summary={sortSummary}
          isOpen={openPanel === 'sort'}
          onPress={() => {
            setOpenPanel((current) => current === 'sort' ? null : 'sort');
          }}
        />
      </Box>

      {openPanel === 'filter' ? (
        <Box
          testID="models-filter-panel"
          className="mt-2 rounded-2xl border border-outline-200 bg-background-50 p-2 dark:border-outline-800 dark:bg-background-900/70"
        >
          {hasActiveFilters ? (
            <Box className="mb-2 flex-row justify-end">
              <Pressable
                testID="models-filter-clear"
                onPress={onClear}
                className="rounded-full border border-primary-500/20 bg-primary-500/10 px-2.5 py-1.5 active:opacity-80"
              >
                <Text className="text-2xs font-semibold text-primary-500">{t('common.clear')}</Text>
              </Pressable>
            </Box>
          ) : null}

          <Box className="gap-1.5">
            <OptionRow
              testID="filter-option-fits-in-ram"
              label={t('models.fitsInRam')}
              active={filters.fitsInRamOnly}
              onPress={() => onFitsInRamToggle(!filters.fitsInRamOnly)}
            />

            {showStatusFilters ? (
              <Box className="my-1 h-px bg-outline-200 dark:bg-outline-800" />
            ) : null}

            {showStatusFilters
              ? STATUS_OPTIONS.map((option) => (
                  <OptionRow
                    key={option.value}
                    testID={`filter-option-status-${option.value}`}
                    label={t(option.labelKey)}
                    active={filters.statuses.includes(option.value)}
                    onPress={() => onStatusToggle(option.value)}
                  />
                ))
              : null}

            <Box className="my-1 h-px bg-outline-200 dark:bg-outline-800" />

            {SIZE_OPTIONS.map((option) => (
              <OptionRow
                key={option.value}
                testID={`filter-option-size-${option.value}`}
                label={option.label}
                active={filters.sizeRanges.includes(option.value)}
                onPress={() => onSizeRangeToggle(option.value)}
              />
            ))}
          </Box>
        </Box>
      ) : null}

      {openPanel === 'sort' ? (
        <Box
          testID="models-sort-panel"
          className="mt-2 rounded-2xl border border-outline-200 bg-background-50 p-2 dark:border-outline-800 dark:bg-background-900/70"
        >
          <Box className="gap-1.5">
            {SORT_OPTIONS.map((option) => {
              const isActive = sort.field === option.field;
              const nextDirection =
                option.field === 'downloaded'
                  ? 'desc'
                  : isActive && sort.direction === 'asc'
                    ? 'desc'
                    : 'asc';
              const trailingLabel =
                option.field === 'downloaded'
                  ? undefined
                  : isActive
                    ? (sort.direction === 'asc' ? '↑' : '↓')
                    : undefined;

              return (
                <OptionRow
                  key={option.field}
                  testID={`sort-option-${option.field}`}
                  label={t(option.labelKey)}
                  active={isActive}
                  trailingLabel={trailingLabel}
                  onPress={() => {
                    onSortChange({
                      field: option.field,
                      direction: nextDirection,
                    });
                    setOpenPanel(null);
                  }}
                />
              );
            })}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
};
