import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { SearchHeader } from '@/components/ui/SearchHeader';
import { ScreenAndroidContentBlurTarget, ScreenContent, ScreenRoot } from '@/components/ui/ScreenShell';
import { ModelsList } from '@/components/models/ModelsList';
import { MODEL_CATALOG_LIST_TOP_OFFSET } from '@/components/models/modelCatalogLayout';
import { resolveModelsCatalogTab, type ModelsCatalogTab } from '@/store/modelsCatalogTabs';
import { useLocalSearchParams, useRouter } from 'expo-router';

const DeferredModelsList = React.memo(ModelsList);
DeferredModelsList.displayName = 'DeferredModelsList';

interface CatalogRenderSnapshot {
  activeTab: ModelsCatalogTab;
  searchQuery: string;
  searchSessionKey: number;
}

interface CatalogChromeContextValue {
  activeTab: ModelsCatalogTab;
  searchQuery: string;
  isDeferredCatalogContentStale: boolean;
  catalogContentBlurTargetRef: React.RefObject<View | null>;
  onSearchChange: (query: string) => void;
  onTabChange: (tab: ModelsCatalogTab) => void;
  onOpenStorage: () => void;
  onControlsContentOffsetChange: (offset: number) => void;
}

const CatalogChromeContext = React.createContext<CatalogChromeContextValue | null>(null);

const CatalogContentContainer = React.memo(({
  children,
  floatingControls,
}: {
  children: ReactNode;
  floatingControls: ReactNode;
}) => {
  const chrome = React.useContext(CatalogChromeContext);
  if (!chrome) {
    throw new Error('CatalogContentContainer must be rendered inside CatalogChromeContext');
  }

  return (
    <ScreenAndroidContentBlurTarget
      blurTargetRef={chrome.catalogContentBlurTargetRef}
      style={styles.catalogContentBlurTarget}
      testID="models-catalog-content-blur-target"
    >
      <SearchHeader
        androidContentBlurTargetRef={chrome.catalogContentBlurTargetRef}
        searchQuery={chrome.searchQuery}
        onSearchChange={chrome.onSearchChange}
        activeTab={chrome.activeTab}
        onTabChange={chrome.onTabChange}
        onBack={undefined}
        onOpenStorage={chrome.onOpenStorage}
        floatingControls={floatingControls}
        onControlsContentOffsetChange={chrome.onControlsContentOffsetChange}
      />
      <ScreenContent
        testID="models-screen-content"
        className="flex-1"
        respectFloatingHeader={false}
        style={{ paddingBottom: 0 }}
      >
        <View
          accessibilityElementsHidden={chrome.isDeferredCatalogContentStale}
          importantForAccessibility={chrome.isDeferredCatalogContentStale ? 'no-hide-descendants' : 'auto'}
          pointerEvents={chrome.isDeferredCatalogContentStale ? 'none' : 'auto'}
          style={styles.deferredCatalogContent}
          testID="models-deferred-catalog-content"
        >
          {children}
        </View>
      </ScreenContent>
    </ScreenAndroidContentBlurTarget>
  );
});

CatalogContentContainer.displayName = 'CatalogContentContainer';

function renderCatalogContentContainer(content: ReactNode, floatingControls: ReactNode): ReactNode {
  return (
    <CatalogContentContainer floatingControls={floatingControls}>
      {content}
    </CatalogContentContainer>
  );
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
  const [catalogContentTopOffset, setCatalogContentTopOffset] = useState(
    MODEL_CATALOG_LIST_TOP_OFFSET,
  );

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
  const handleOpenStorage = useCallback(() => {
    router.push('/storage');
  }, [router]);
  const handleControlsContentOffsetChange = useCallback((offset: number) => {
    setCatalogContentTopOffset((current) => (
      Math.abs(current - offset) < 0.5 ? current : offset
    ));
  }, []);
  const catalogChromeContextValue = useMemo<CatalogChromeContextValue>(() => ({
    activeTab,
    searchQuery,
    isDeferredCatalogContentStale,
    catalogContentBlurTargetRef,
    onSearchChange: handleSearchChange,
    onTabChange: handleTabChange,
    onOpenStorage: handleOpenStorage,
    onControlsContentOffsetChange: handleControlsContentOffsetChange,
  }), [
    activeTab,
    handleOpenStorage,
    handleControlsContentOffsetChange,
    handleSearchChange,
    handleTabChange,
    isDeferredCatalogContentStale,
    searchQuery,
  ]);

  return (
    <CatalogChromeContext.Provider value={catalogChromeContextValue}>
      <ScreenRoot>
        <DeferredModelsList
          activeTab={deferredCatalogRenderSnapshot.activeTab}
          searchQuery={deferredCatalogRenderSnapshot.searchQuery}
          searchSessionKey={deferredCatalogRenderSnapshot.searchSessionKey}
          androidContentBlurTargetRef={catalogContentBlurTargetRef}
          catalogContentTopOffset={catalogContentTopOffset}
          renderContentContainer={renderCatalogContentContainer}
        />
      </ScreenRoot>
    </CatalogChromeContext.Provider>
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
