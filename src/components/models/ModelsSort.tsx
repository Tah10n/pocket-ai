import React from 'react';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { ModelSortField, ModelSortPreference } from '@/store/modelsStore';

interface ModelsSortProps {
  sort: ModelSortPreference;
  onSortChange: (sort: ModelSortPreference) => void;
}

const SORT_OPTIONS: { label: string; field: ModelSortField }[] = [
  { label: 'Name', field: 'name' },
  { label: 'Size', field: 'size' },
  { label: 'Downloaded First', field: 'downloaded' },
];

export const ModelsSort = ({ sort, onSortChange }: ModelsSortProps) => {
  return (
    <Box className="gap-2 border-b border-outline-200 bg-background-0 px-4 py-3 dark:border-outline-800 dark:bg-background-950">
      <Text className="text-sm font-semibold text-typography-700 dark:text-typography-200">
        Sort
      </Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Box className="flex-row gap-2">
          {SORT_OPTIONS.map((option) => {
            const isActive = sort.field === option.field;
            const showDirection = option.field !== 'downloaded' && isActive;

            return (
              <Pressable
                key={option.field}
                onPress={() =>
                  onSortChange({
                    field: option.field,
                    direction:
                      option.field === 'downloaded'
                        ? 'desc'
                        : isActive && sort.direction === 'asc'
                          ? 'desc'
                          : 'asc',
                  })
                }
                className={`rounded-full border px-3 py-2 ${
                  isActive
                    ? 'border-primary-500 bg-primary-500'
                    : 'border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900'
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${
                    isActive ? 'text-typography-0' : 'text-typography-700 dark:text-typography-200'
                  }`}
                >
                  {option.label}
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
