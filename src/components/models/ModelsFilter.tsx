import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { LifecycleStatus } from '@/types/models';
import { ModelFilterCriteria, ModelSizeRange } from '@/store/modelsStore';

interface ModelsFilterProps {
  filters: ModelFilterCriteria;
  onFitsInRamToggle: (enabled: boolean) => void;
  onStatusToggle: (status: LifecycleStatus) => void;
  onSizeRangeToggle: (sizeRange: ModelSizeRange) => void;
  onClear: () => void;
  showStatusFilters: boolean;
}

type FilterChipProps = {
  label: string;
  active: boolean;
  onPress: () => void;
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

const FilterChip = ({ label, active, onPress }: FilterChipProps) => (
  <Pressable
    onPress={onPress}
    className={`rounded-full border px-3 py-2 ${
      active
        ? 'border-primary-500 bg-primary-500'
        : 'border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900'
    }`}
  >
    <Text
      className={`text-xs font-semibold ${
        active ? 'text-typography-0' : 'text-typography-700 dark:text-typography-200'
      }`}
    >
      {label}
    </Text>
  </Pressable>
);

export const ModelsFilter = ({
  filters,
  onFitsInRamToggle,
  onStatusToggle,
  onSizeRangeToggle,
  onClear,
  showStatusFilters,
}: ModelsFilterProps) => {
  const { t } = useTranslation();
  const hasActiveFilters =
    filters.fitsInRamOnly || filters.statuses.length > 0 || filters.sizeRanges.length > 0;

  return (
    <Box className="gap-3 border-b border-outline-200 bg-background-0 px-4 py-3 dark:border-outline-800 dark:bg-background-950">
      <Box className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-typography-700 dark:text-typography-200">
          {t('models.filtersTitle')}
        </Text>
        {hasActiveFilters ? (
          <Pressable onPress={onClear} className="rounded-full px-2 py-1 active:opacity-70">
            <Text className="text-xs font-semibold text-primary-500">{t('common.clear')}</Text>
          </Pressable>
        ) : null}
      </Box>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Box className="flex-row gap-2">
          <FilterChip
            label={t('models.fitsInRam')}
            active={filters.fitsInRamOnly}
            onPress={() => onFitsInRamToggle(!filters.fitsInRamOnly)}
          />

          {showStatusFilters
            ? STATUS_OPTIONS.map((option) => (
                <FilterChip
                  key={option.value}
                  label={t(option.labelKey)}
                  active={filters.statuses.includes(option.value)}
                  onPress={() => onStatusToggle(option.value)}
                />
              ))
            : null}

          {SIZE_OPTIONS.map((option) => (
            <FilterChip
              key={option.value}
              label={option.label}
              active={filters.sizeRanges.includes(option.value)}
              onPress={() => onSizeRangeToggle(option.value)}
            />
          ))}
        </Box>
      </ScrollView>
    </Box>
  );
};
