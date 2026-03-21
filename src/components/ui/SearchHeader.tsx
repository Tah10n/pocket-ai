import React from 'react';
import { Box } from './box';
import { Input, InputField } from './input';
import { Text } from './text';
import { Pressable } from './pressable';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { typographyColors } from '../../utils/themeTokens';

interface SearchHeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeTab: 'All Models' | 'Downloaded';
  onTabChange: (tab: 'All Models' | 'Downloaded') => void;
  onBack?: () => void;
}

export const SearchHeader: React.FC<SearchHeaderProps> = ({
  searchQuery,
  onSearchChange,
  activeTab,
  onTabChange,
  onBack,
}) => {
  const { t } = useTranslation();
  return (
    <Box className="pt-6 px-4 bg-background-0 dark:bg-background-950 z-10">
      <Box className="flex-row items-center justify-between mb-4 mt-2">
        {onBack && (
          <Pressable onPress={onBack} className="active:opacity-70">
            <MaterialIcons name="chevron-left" size={28} className="text-primary-500" />
          </Pressable>
        )}
        <Text className="text-lg font-bold text-typography-900 dark:text-typography-100">{t('models.catalogTitle')}</Text>
        <Box className="w-7" />
      </Box>

      {/* Search Bar */}
      <Box className="flex-row w-full items-center rounded-lg bg-background-50 dark:bg-background-900/60 mb-4 h-10 px-3 border border-outline-200 dark:border-outline-800">
        <MaterialIcons name="search" size={20} className="text-typography-500 dark:text-typography-400" />
        <Input className="flex-1 h-full ml-2 border-0 bg-transparent flex items-center justify-center">
          <InputField 
            className="text-sm text-typography-900 dark:text-typography-100"
            placeholder={t('models.searchPlaceholder')}
            placeholderTextColor={typographyColors[400]}
            value={searchQuery}
            onChangeText={onSearchChange}
          />
        </Input>
        {searchQuery.length > 0 && (
          <Pressable onPress={() => onSearchChange('')} className="active:opacity-70">
            <MaterialIcons name="close" size={18} className="text-typography-400" />
          </Pressable>
        )}
      </Box>

      {/* Tabs */}
      <Box className="flex-row gap-6 border-b border-outline-200 dark:border-primary-500/20">
        {(['All Models', 'Downloaded'] as const).map((tab) => (
          <Pressable 
            key={tab}
            onPress={() => onTabChange(tab)}
            className={`items-center pb-2 border-b-2 ${activeTab === tab ? 'border-primary-500' : 'border-transparent'}`}
          >
            <Text className={`text-sm ${activeTab === tab ? 'font-bold text-primary-500' : 'font-medium text-typography-500 dark:text-typography-400'}`}>
              {tab === 'All Models' ? t('models.tabAllModels') : t('models.tabDownloaded')}
            </Text>
          </Pressable>
        ))}
      </Box>
    </Box>
  );
};
