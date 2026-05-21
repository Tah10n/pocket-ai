import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, type View } from 'react-native';
import { SearchHeader } from '@/components/ui/SearchHeader';
import { ScreenAndroidContentBlurTarget, ScreenContent, ScreenRoot } from '@/components/ui/ScreenShell';
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
  const catalogContentBlurTargetRef = useRef<View | null>(null);

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
  const renderCatalogContentContainer = useCallback((content: ReactNode) => (
    <ScreenAndroidContentBlurTarget
      blurTargetRef={catalogContentBlurTargetRef}
      style={styles.catalogContentBlurTarget}
      testID="models-catalog-content-blur-target"
    >
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
        {content}
      </ScreenContent>
    </ScreenAndroidContentBlurTarget>
  ), [activeTab, handleSearchChange, handleTabChange, router, searchQuery]);

  return (
    <ScreenRoot>
      <ModelsList
        activeTab={activeTab}
        searchQuery={searchQuery}
        searchSessionKey={searchSessionKey}
        androidContentBlurTargetRef={catalogContentBlurTargetRef}
        renderContentContainer={renderCatalogContentContainer}
      />
    </ScreenRoot>
  );
};

const styles = StyleSheet.create({
  catalogContentBlurTarget: {
    flex: 1,
  },
});
