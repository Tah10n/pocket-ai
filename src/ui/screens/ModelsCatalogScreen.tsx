import React, { useCallback, useEffect, useState } from 'react';
import { Box } from '@/components/ui/box';
import { SearchHeader } from '@/components/ui/SearchHeader';
import { ScreenContent } from '@/components/ui/ScreenShell';
import { ModelsList } from '@/components/models/ModelsList';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useModelsStore } from '@/store/modelsStore';

export const ModelsCatalogScreen = () => {
  const router = useRouter();
  const params = useLocalSearchParams<{ initialTab?: string }>();
  const requestedTab = params.initialTab === 'downloaded' ? 'Downloaded' : 'All Models';
  const [activeTab, setActiveTab] = useState<'All Models' | 'Downloaded'>(requestedTab);
  const [searchQuery, setSearchQuery] = useState('');
  const resetPagination = useModelsStore((state) => state.resetPagination);

  useEffect(() => {
    setActiveTab(requestedTab);
    resetPagination();
  }, [requestedTab, resetPagination]);

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
        onOpenStorage={() => router.push('/storage' as any)}
      />
      <ScreenContent className="flex-1">
        <ModelsList activeTab={activeTab} searchQuery={searchQuery} />
      </ScreenContent>
    </Box>
  );
};
