import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SearchHeader } from '@/components/ui/SearchHeader';
import { ScreenAndroidContentBlurTarget, ScreenContent, ScreenRoot } from '@/components/ui/ScreenShell';
import { ModelsList } from '@/components/models/ModelsList';
import { resolveModelsCatalogTab, type ModelsCatalogTab } from '@/store/modelsCatalogTabs';
import { useLocalSearchParams, useRouter } from 'expo-router';

const DeferredModelsList = React.memo(ModelsList);
DeferredModelsList.displayName = 'DeferredModelsList';

interface CatalogRenderSnapshot {
  activeTab: ModelsCatalogTab;
  searchQuery: string;
  searchSessionKey: number;
}

export const ModelsCatalogScreen = () => {
  const router = useRouter();
  const params = useLocalSearchParams<{ initialTab?: string }>();
  const requestedTab = resolveModelsCatalogTab(params.initialTab);
  const [activeTab, setActiveTab] = useState<ModelsCatalogTab>(requestedTab);
  const [searchState, setSearchState] = useState({ query: '', sessionKey: 0 });
  const { query: searchQuery, sessionKey: searchSessionKey } = searchState;
  const catalogRenderSnapshot = useMemo<CatalogRenderSnapshot>(() => ({
    activeTab,
    searchQuery,
    searchSessionKey,
  }), [activeTab, searchQuery, searchSessionKey]);
  const deferredCatalogRenderSnapshot = useDeferredValue(catalogRenderSnapshot);
  const isDeferredCatalogContentStale =
    activeTab !== deferredCatalogRenderSnapshot.activeTab
    || searchQuery !== deferredCatalogRenderSnapshot.searchQuery
    || searchSessionKey !== deferredCatalogRenderSnapshot.searchSessionKey;
  const catalogContentBlurTargetRef = useRef<View | null>(null);

  useEffect(() => {
    setActiveTab(requestedTab);
  }, [requestedTab]);

  const handleSearchChange = useCallback((query: string) => {
    setSearchState((current) => {
      if (current.query === query) {
        return current;
      }

      return {
        query,
        sessionKey: current.sessionKey + 1,
      };
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
          <View
            accessibilityElementsHidden={isDeferredCatalogContentStale}
            importantForAccessibility={isDeferredCatalogContentStale ? 'no-hide-descendants' : 'auto'}
            pointerEvents={isDeferredCatalogContentStale ? 'none' : 'auto'}
            style={styles.deferredCatalogContent}
            testID="models-deferred-catalog-content"
          >
            <DeferredModelsList
              activeTab={deferredCatalogRenderSnapshot.activeTab}
              searchQuery={deferredCatalogRenderSnapshot.searchQuery}
              searchSessionKey={deferredCatalogRenderSnapshot.searchSessionKey}
              androidContentBlurTargetRef={catalogContentBlurTargetRef}
            />
          </View>
        </ScreenContent>
      </ScreenAndroidContentBlurTarget>
    </ScreenRoot>
  );
};

const styles = StyleSheet.create({
  catalogContentBlurTarget: {
    flex: 1,
  },
  deferredCatalogContent: {
    flex: 1,
  },
});
