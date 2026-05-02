import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { MaterialSymbols, type MaterialSymbolName } from '@/components/ui/MaterialSymbols';
import { Pressable } from '@/components/ui/pressable';
import { joinClassNames, ScreenActionPill, ScreenBadge, ScreenPressableSurface, ScreenSurface, useScreenAppearance } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { ModelFilterCriteria, ModelSizeRange, ModelSortField, ModelSortPreference } from '@/store/modelsStore';
import { getThemeActionContentClassName } from '@/utils/themeTokens';

interface ModelsFilterProps {
  filters: ModelFilterCriteria;
  sort: ModelSortPreference;
  onFitsInRamToggle: (enabled: boolean) => void;
  onNoTokenRequiredToggle: (enabled: boolean) => void;
  onSizeRangeToggle: (sizeRange: ModelSizeRange) => void;
  onSortChange: (sort: ModelSortPreference) => void;
  onClear: () => void;
}

type OpenPanel = 'filter' | 'sort' | null;

type TriggerButtonProps = {
  testID: string;
  iconName: MaterialSymbolName;
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

const SIZE_OPTIONS: { labelKey: string; value: ModelSizeRange }[] = [
  { labelKey: 'models.sizeRangeSmall', value: 'small' },
  { labelKey: 'models.sizeRangeMedium', value: 'medium' },
  { labelKey: 'models.sizeRangeLarge', value: 'large' },
];

const SORT_OPTIONS: { labelKey: string; field: ModelSortField }[] = [
  { labelKey: 'models.sortMostDownloaded', field: 'downloads' },
  { labelKey: 'models.sortMostPopular', field: 'likes' },
  { labelKey: 'models.sortLastModified', field: 'lastModified' },
  { labelKey: 'models.sortName', field: 'name' },
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
  const appearance = useScreenAppearance();

  return (
    <ScreenPressableSurface
      testID={testID}
      onPress={onPress}
      tone={isOpen ? 'accent' : 'neutral'}
      withControlTint={isOpen}
      className={joinClassNames(
        'min-w-0 flex-1 flex-row items-center gap-1.5 rounded-2xl border px-2.5 py-2 active:opacity-80',
        isOpen
          ? appearance.classNames.toneClassNameByTone.accent.surfaceClassName
          : appearance.classNames.toneClassNameByTone.neutral.surfaceClassName,
      )}
    >
      <Box className="min-w-0 flex-1 flex-row items-center gap-2">
        <MaterialSymbols
          name={iconName}
          size="sm"
          className={isOpen ? 'text-primary-500' : 'text-typography-500 dark:text-typography-400'}
        />

        <Text numberOfLines={1} className="min-w-0 flex-1 font-semibold text-sm text-typography-900 dark:text-typography-100">
          {label}
        </Text>
      </Box>

      <Box className="ml-1.5 flex-row items-center gap-1.5">
        {summary ? (
          <Text
            numberOfLines={1}
            className="max-w-[84px] text-xs text-typography-500 dark:text-typography-400"
          >
            {summary}
          </Text>
        ) : null}
        {badge ? (
          <ScreenBadge tone="accent" size="micro">
            {badge}
          </ScreenBadge>
        ) : null}
        <MaterialSymbols
          name={isOpen ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
          size="sm"
          className={isOpen ? 'text-primary-500' : 'text-typography-500 dark:text-typography-400'}
        />
      </Box>
    </ScreenPressableSurface>
  );
}

function OptionRow({
  testID,
  label,
  active,
  onPress,
  trailingLabel,
}: OptionRowProps) {
  const appearance = useScreenAppearance();
  const activeControlClassName = appearance.surfaceKind === 'glass'
    ? 'border-primary-500/18 bg-primary-500/8'
    : 'border-primary-500 bg-primary-500';
  const activeIconClassName = getThemeActionContentClassName(appearance, 'primary');

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      className={joinClassNames(
        'flex-row items-center justify-between rounded-xl px-3 py-2 active:opacity-80',
        active ? appearance.classNames.selectedInsetCardClassName : undefined,
      )}
    >
      <Box className="min-w-0 flex-1 flex-row items-center gap-2">
        <ScreenSurface
          tone={active ? 'accent' : 'neutral'}
          withControlTint={active}
          className={`h-5 w-5 items-center justify-center rounded-full border ${
          active
            ? activeControlClassName
            : appearance.classNames.toneClassNameByTone.neutral.iconTileClassName
        }`}
        >
          {active ? (
            <MaterialSymbols name="check" size={12} className={activeIconClassName} />
          ) : null}
        </ScreenSurface>
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
    + (filters.noTokenRequiredOnly ? 1 : 0)
    + filters.sizeRanges.length
  );
}

function getSortSummary(t: (key: string) => string, sort: ModelSortPreference) {
  const activeOption = SORT_OPTIONS.find((option) => option.field === sort.field);
  if (!activeOption) {
    return '';
  }

  if (sort.field === 'downloaded' || sort.field === 'downloads' || sort.field === 'likes') {
    return t(activeOption.labelKey);
  }

  if (sort.field === 'lastModified') {
    return t(activeOption.labelKey);
  }

  return `${t(activeOption.labelKey)} ${sort.direction === 'asc' ? '↑' : '↓'}`;
}

export const ModelsFilter = ({
  filters,
  sort,
  onFitsInRamToggle,
  onNoTokenRequiredToggle,
  onSizeRangeToggle,
  onSortChange,
  onClear,
}: ModelsFilterProps) => {
  const { t } = useTranslation();
  const appearance = useScreenAppearance();
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const activeFilterCount = getActiveFilterCount(filters);
  const hasActiveFilters = activeFilterCount > 0;
  const sortSummary = getSortSummary(t, sort);

  return (
    <Box className={`${appearance.classNames.surfaceBarClassName} py-1.5`}>
      <Box className="flex-row gap-1.5">
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
        <ScreenSurface
          testID="models-filter-panel"
          tone="neutral"
          className={`mt-1.5 p-1.5 ${appearance.classNames.insetCardClassName}`}
        >
          {hasActiveFilters ? (
            <Box className="mb-1.5 flex-row justify-end">
              <ScreenActionPill
                testID="models-filter-clear"
                onPress={onClear}
                tone="soft"
                size="sm"
              >
                <Text className="text-xs font-semibold text-primary-500">{t('common.clear')}</Text>
              </ScreenActionPill>
            </Box>
          ) : null}

          <Box className="gap-1">
            <OptionRow
              testID="filter-option-fits-in-ram"
              label={t('models.fitsInRam')}
              active={filters.fitsInRamOnly}
              onPress={() => onFitsInRamToggle(!filters.fitsInRamOnly)}
            />

            <OptionRow
              testID="filter-option-no-token-required"
              label={t('models.noTokenRequired')}
              active={filters.noTokenRequiredOnly}
              onPress={() => onNoTokenRequiredToggle(!filters.noTokenRequiredOnly)}
            />

            <Box className={`my-1 h-px border-t ${appearance.classNames.dividerClassName}`} />

            {SIZE_OPTIONS.map((option) => (
              <OptionRow
                key={option.value}
                testID={`filter-option-size-${option.value}`}
                label={t(option.labelKey)}
                active={filters.sizeRanges.includes(option.value)}
                onPress={() => onSizeRangeToggle(option.value)}
              />
            ))}
          </Box>
        </ScreenSurface>
      ) : null}

      {openPanel === 'sort' ? (
        <ScreenSurface
          testID="models-sort-panel"
          tone="neutral"
          className={`mt-1.5 p-1.5 ${appearance.classNames.insetCardClassName}`}
        >
          <Box className="gap-1">
            {SORT_OPTIONS.map((option) => {
              const isActive = sort.field === option.field;
              const nextDirection =
                option.field === 'downloaded'
                || option.field === 'downloads'
                || option.field === 'likes'
                || option.field === 'lastModified'
                  ? 'desc'
                  : isActive && sort.direction === 'asc'
                    ? 'desc'
                    : 'asc';
              const trailingLabel =
                option.field === 'downloaded'
                || option.field === 'downloads'
                || option.field === 'likes'
                || option.field === 'lastModified'
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
        </ScreenSurface>
      ) : null}
    </Box>
  );
};
