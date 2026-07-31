import React, { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { StyleSheet, type View } from 'react-native';
import { SearchHeader } from '@/components/ui/SearchHeader';
import { ScreenAndroidContentBlurTarget, ScreenContent, ScreenRoot } from '@/components/ui/ScreenShell';
import { ModelsList } from '@/components/models/ModelsList';
import { resolveModelsCatalogTab, type ModelsCatalogTab } from '@/store/modelsCatalogTabs';
import { useLocalSearchParams, useRouter } from 'expo-router';

const DeferredModelsList = React.memo(ModelsList);
DeferredModelsList.displayName = 'DeferredModelsList';

export const ModelsCatalogScreen = () => {
  const router = useRouter();
  const params = useLocalSearchParams<{ initialTab?: string }>();
  const requestedTab = resolveModelsCatalogTab(params.initialTab);
  const [activeTab, setActiveTab] = useState<ModelsCatalogTab>(requestedTab);
  const deferredActiveTab = useDeferredValue(activeTab);
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

  return (
    <ScreenRoot>
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
          <DeferredModelsList
            activeTab={deferredActiveTab}
            searchQuery={searchQuery}
            searchSessionKey={searchSessionKey}
            androidContentBlurTargetRef={catalogContentBlurTargetRef}
          />
        </ScreenContent>
      </ScreenAndroidContentBlurTarget>
    </ScreenRoot>
  );
};

const styles = StyleSheet.create({
  catalogContentBlurTarget: {
    flex: 1,
  },
});
