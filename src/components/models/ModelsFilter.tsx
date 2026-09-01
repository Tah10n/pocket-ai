import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { MaterialSymbols, type MaterialSymbolName } from '@/components/ui/MaterialSymbols';
import { Pressable } from '@/components/ui/pressable';
import {
  joinClassNames,
  ScreenActionPill,
  ScreenBadge,
  ScreenSurface,
  useAndroidLiquidGlassSceneRefresh,
} from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { ModelFilterCriteria, ModelSizeRange, ModelSortField, ModelSortPreference } from '@/store/modelsStore';
import { useTheme } from '@/providers/ThemeProvider';
import { EffectPressableSurface, EffectSurface } from '@/design-system/materials/EffectSurface';
import type { AndroidBlurTargetRef } from '@/utils/androidBlur';

interface ModelsFilterProps {
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
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
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
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
  androidContentBlurTargetRef,
  testID,
  iconName,
  label,
  summary,
  badge,
  isOpen,
  onPress,
}: TriggerButtonProps) {
  return (
    <EffectPressableSurface
      testID={testID}
      androidBlurTargetRef={androidContentBlurTargetRef}
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={summary ? `${label}: ${summary}` : label}
      accessibilityState={{ expanded: isOpen }}
      material={{
        role: 'control',
        variant: 'floating',
        tone: isOpen ? 'primary' : 'neutral',
      }}
      shape="full"
      className={joinClassNames(
        'h-9 min-w-0 flex-1 rounded-full active:opacity-80',
      )}
    >
      <Box className="h-full w-full flex-row items-center gap-1.5 px-2.5">
        <Box className="min-w-0 flex-1 flex-row items-center gap-2">
          <MaterialSymbols
            name={iconName}
            size="sm"
            colorRole={isOpen ? 'accent' : 'tertiary'}
          />

          <Text colorRole="primary" numberOfLines={1} className="min-w-0 flex-1 font-semibold text-sm  ">
            {summary ?? label}
          </Text>
        </Box>

        <Box className="ml-1.5 flex-row items-center gap-1.5">
          {badge ? (
            <ScreenBadge tone="accent" size="micro">
              {badge}
            </ScreenBadge>
          ) : null}
          <MaterialSymbols
            name={isOpen ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
            size="sm"
            colorRole={isOpen ? 'accent' : 'tertiary'}
          />
        </Box>
      </Box>
    </EffectPressableSurface>
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
      className={joinClassNames(
        'flex-row items-center justify-between rounded-xl px-3 py-2 active:opacity-80',
      )}
    >
      <Box className="min-w-0 flex-1 flex-row items-center gap-2">
        <ScreenSurface
          material={{
            role: 'control',
            variant: active ? 'selected' : 'inline',
            tone: active ? 'primary' : 'neutral',
          }}
          shape="full"
          className="h-5 w-5 items-center justify-center"
        >
          {active ? (
            <MaterialSymbols name="check" size={12} colorRole="onAccent" />
          ) : null}
        </ScreenSurface>
        <Text colorRole="primary" className="shrink text-sm  ">{label}</Text>
      </Box>

      {trailingLabel ? (
        <Text colorRole="tertiary" className="ml-3 text-2xs font-semibold  ">
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
  androidContentBlurTargetRef,
  filters,
  sort,
  onFitsInRamToggle,
  onNoTokenRequiredToggle,
  onSizeRangeToggle,
  onSortChange,
  onClear,
}: ModelsFilterProps) => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const requestAndroidLiquidGlassSceneRefresh = useAndroidLiquidGlassSceneRefresh();
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const activeFilterCount = getActiveFilterCount(filters);
  const hasActiveFilters = activeFilterCount > 0;
  const sortSummary = getSortSummary(t, sort);
  const handlePanelLayout = useCallback(() => {
    requestAndroidLiquidGlassSceneRefresh();
  }, [requestAndroidLiquidGlassSceneRefresh]);
  return (
    <Box>
      <Box className="flex-row gap-1.5">
        <TriggerButton
          androidContentBlurTargetRef={androidContentBlurTargetRef}
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
          androidContentBlurTargetRef={androidContentBlurTargetRef}
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
        <EffectSurface
          testID="models-filter-panel"
          androidBlurTargetRef={androidContentBlurTargetRef}
          material={{ role: 'overlay', variant: 'popover', tone: 'neutral' }}
          shape="md"
          className="mt-1.5 p-1.5"
          onLayout={handlePanelLayout}
        >
          {hasActiveFilters ? (
            <Box className="mb-1.5 flex-row justify-end">
              <ScreenActionPill
                testID="models-filter-clear"
                onPress={onClear}
                tone="soft"
                size="sm"
              >
                <Text colorRole="accent" className="text-xs font-semibold ">{t('common.clear')}</Text>
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

            <Box className="my-1 h-px border-t" style={{ borderColor: colors.divider }} />

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
        </EffectSurface>
      ) : null}

      {openPanel === 'sort' ? (
        <EffectSurface
          testID="models-sort-panel"
          androidBlurTargetRef={androidContentBlurTargetRef}
          material={{ role: 'overlay', variant: 'popover', tone: 'neutral' }}
          shape="md"
          className="mt-1.5 p-1.5"
          onLayout={handlePanelLayout}
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
        </EffectSurface>
      ) : null}
    </Box>
  );
};
