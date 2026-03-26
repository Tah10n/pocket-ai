import React from 'react';
import { Box } from './box';
import { Input, InputField } from './input';
import { Text } from './text';
import { Pressable } from './pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { ScreenHeaderShell } from './ScreenShell';
import { useTranslation } from 'react-i18next';
import { typographyColors } from '../../utils/themeTokens';

interface SearchHeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeTab: 'All Models' | 'Downloaded';
  onTabChange: (tab: 'All Models' | 'Downloaded') => void;
  onBack?: () => void;
  onOpenStorage?: () => void;
}

export const SearchHeader: React.FC<SearchHeaderProps> = ({
  searchQuery,
  onSearchChange,
  activeTab,
  onTabChange,
  onBack,
  onOpenStorage,
}) => {
  const { t } = useTranslation();

  return (
    <ScreenHeaderShell contentClassName="px-4 pb-4 pt-2">
      <Box className="flex-row items-center gap-3">
        {onBack ? (
          <Pressable
            onPress={onBack}
            className="h-11 w-11 items-center justify-center rounded-full bg-background-50 active:opacity-70 dark:bg-background-900/60"
          >
            <MaterialSymbols name="arrow-back-ios-new" size={20} className="text-primary-500" />
          </Pressable>
        ) : (
          <Box className="h-11 w-11" />
        )}

        <Box className="flex-1">
          <Text className="text-xl font-bold text-typography-900 dark:text-typography-100">
            {t('models.catalogTitle')}
          </Text>
        </Box>

        {onOpenStorage ? (
          <Pressable
            onPress={onOpenStorage}
            className="h-11 w-11 items-center justify-center rounded-full bg-background-50 active:opacity-70 dark:bg-background-900/60"
          >
            <MaterialSymbols name="storage" size={20} className="text-primary-500" />
          </Pressable>
        ) : (
          <Box className="h-11 w-11" />
        )}
      </Box>

      <Box className="mt-4 flex-row w-full items-center rounded-2xl bg-background-50 dark:bg-background-900/60 h-12 px-3 border border-outline-200 dark:border-outline-800">
        <MaterialSymbols name="search" size={20} className="text-typography-500 dark:text-typography-400" />
        <Input className="ml-2 flex-1 h-full border-0 bg-transparent justify-center">
          <InputField
            className="text-sm text-typography-900 dark:text-typography-100"
            placeholder={t('models.searchPlaceholder')}
            placeholderTextColor={typographyColors[400]}
            value={searchQuery}
            onChangeText={onSearchChange}
          />
        </Input>
        {searchQuery.length > 0 ? (
          <Pressable onPress={() => onSearchChange('')} className="h-9 w-9 items-center justify-center rounded-full active:opacity-70">
            <MaterialSymbols name="close" size={18} className="text-typography-400" />
          </Pressable>
        ) : null}
      </Box>

      <Box className="mt-4 flex-row gap-6 border-b border-outline-200 dark:border-primary-500/20">
        {(['All Models', 'Downloaded'] as const).map((tab) => (
          <Pressable
            key={tab}
            onPress={() => onTabChange(tab)}
            className={`items-center pb-3 border-b-2 ${activeTab === tab ? 'border-primary-500' : 'border-transparent'}`}
          >
            <Text className={`text-sm ${activeTab === tab ? 'font-bold text-primary-500' : 'font-medium text-typography-500 dark:text-typography-400'}`}>
              {tab === 'All Models' ? t('models.tabAllModels') : t('models.tabDownloaded')}
            </Text>
          </Pressable>
        ))}
      </Box>
    </ScreenHeaderShell>
  );
};
