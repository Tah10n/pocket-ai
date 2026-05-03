import React, { useCallback, useEffect, useState } from 'react';
import { SearchHeader } from '@/components/ui/SearchHeader';
import { ScreenContent, ScreenRoot } from '@/components/ui/ScreenShell';
import { ModelsList } from '@/components/models/ModelsList';
import { resolveModelsCatalogTab, type ModelsCatalogTab } from '@/store/modelsCatalogTabs';
import { useLocalSearchParams, useRouter } from 'expo-router';

export const ModelsCatalogScreen = () => {
  const router = useRouter();
  const params = useLocalSearchParams<{ initialTab?: string }>();
  const requestedTab = resolveModelsCatalogTab(params.initialTab);
  const [activeTab, setActiveTab] = useState<ModelsCatalogTab>(requestedTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchSessionKey, setSearchSessionKey] = useState(0);

  useEffect(() => {
    setActiveTab(requestedTab);
  }, [requestedTab]);

  const handleSearchChange = useCallback((query: string) => {
    setSearchQuery((current) => {
      if (current === query) {
        return current;
      }

      setSearchSessionKey((sessionKey) => sessionKey + 1);
      return query;
    });
  }, []);

  const handleTabChange = useCallback((tab: ModelsCatalogTab) => {
    setActiveTab(tab);
  }, []);

  return (
    <ScreenRoot>
      <SearchHeader
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onBack={undefined}
        onOpenStorage={() => router.push('/storage')}
      />
      <ScreenContent
        testID="models-screen-content"
        className="flex-1"
        respectFloatingHeader={false}
        style={{ paddingBottom: 0 }}
      >
        <ModelsList
          activeTab={activeTab}
          searchQuery={searchQuery}
          searchSessionKey={searchSessionKey}
        />
      </ScreenContent>
    </ScreenRoot>
  );
};
