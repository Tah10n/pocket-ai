import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { ScrollView } from '@/components/ui/scroll-view';
import { ScreenSurface } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { PressableSurface } from '@/design-system/materials/Surface';
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
  return (
    <ScreenSurface shape="none" className="gap-2 px-4 py-3">
      <Text colorRole="secondary" className="text-sm font-semibold  ">
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
              <PressableSurface
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
                material={{
                  role: 'control',
                  variant: isActive ? 'selected' : 'inline',
                  tone: isActive ? 'primary' : 'neutral',
                }}
                shape="full"
                className="px-3 py-2"
              >
                <Text
                  colorRole={isActive ? 'onAccent' : 'primary'}
                  className="text-xs font-semibold"
                >
                  {t(option.labelKey)}
                  {showDirection ? ` ${sort.direction === 'asc' ? '↑' : '↓'}` : ''}
                </Text>
              </PressableSurface>
            );
          })}
        </Box>
      </ScrollView>
    </ScreenSurface>
  );
};
