import React, { useCallback, useState } from 'react';
import { Box } from '@/components/ui/box';
import { SearchHeader } from '@/components/ui/SearchHeader';
import { ModelsList } from '@/components/models/ModelsList';
import { useRouter } from 'expo-router';
import { useModelsStore } from '@/store/modelsStore';

export const ModelsCatalogScreen = () => {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'All Models' | 'Downloaded'>('All Models');
  const [searchQuery, setSearchQuery] = useState('');
  const resetPagination = useModelsStore((state) => state.resetPagination);

  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    resetPagination();
  }, [resetPagination]);

  const handleTabChange = useCallback((tab: 'All Models' | 'Downloaded') => {
    setActiveTab(tab);
    resetPagination();
  }, [resetPagination]);

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <SearchHeader 
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onBack={() => router.back()}
      />
      <ModelsList activeTab={activeTab} searchQuery={searchQuery} />
    </Box>
  );
};
