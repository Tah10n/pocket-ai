import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { joinClassNames, useScreenAppearance } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { ModelSortField, ModelSortPreference } from '@/store/modelsStore';

interface ModelsSortProps {
  sort: ModelSortPreference;
  onSortChange: (sort: ModelSortPreference) => void;
}

const SORT_OPTIONS: { labelKey: string; field: ModelSortField }[] = [
  { labelKey: 'models.sortMostDownloaded', field: 'downloads' },
  { labelKey: 'models.sortMostPopular', field: 'likes' },
  { labelKey: 'models.sortLastModified', field: 'lastModified' },
  { labelKey: 'models.sortName', field: 'name' },
  { labelKey: 'models.sortDownloadedFirst', field: 'downloaded' },
];

export const ModelsSort = ({ sort, onSortChange }: ModelsSortProps) => {
  const { t } = useTranslation();
  const appearance = useScreenAppearance();

  return (
    <Box className={`${appearance.classNames.surfaceBarClassName} gap-2 px-4 py-3`}>
      <Text className="text-sm font-semibold text-typography-700 dark:text-typography-200">
        {t('models.sortTitle')}
      </Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Box className="flex-row gap-2">
          {SORT_OPTIONS.map((option) => {
            const isActive = sort.field === option.field;
            const showDirection =
              option.field !== 'downloaded'
              && option.field !== 'downloads'
              && option.field !== 'likes'
              && option.field !== 'lastModified'
              && isActive;

            return (
              <Pressable
                key={option.field}
                onPress={() =>
                  onSortChange({
                    field: option.field,
                    direction:
                      option.field === 'downloaded'
                      || option.field === 'downloads'
                      || option.field === 'likes'
                      || option.field === 'lastModified'
                        ? 'desc'
                        : isActive && sort.direction === 'asc'
                          ? 'desc'
                          : 'asc',
                  })
                }
                className={joinClassNames(
                  'rounded-full border px-3 py-2',
                  isActive
                    ? 'border-primary-500 bg-primary-500'
                    : appearance.classNames.toneClassNameByTone.neutral.badgeClassName,
                )}
              >
                <Text
                  className={`text-xs font-semibold ${
                    isActive ? 'text-typography-0' : 'text-typography-700 dark:text-typography-200'
                  }`}
                >
                  {t(option.labelKey)}
                  {showDirection ? ` ${sort.direction === 'asc' ? '↑' : '↓'}` : ''}
                </Text>
              </Pressable>
            );
          })}
        </Box>
      </ScrollView>
    </Box>
  );
};
