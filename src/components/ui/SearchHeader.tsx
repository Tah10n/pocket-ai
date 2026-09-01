import React, { type ReactNode, useCallback } from 'react';
import { StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Box } from './box';
import { Text, composeTextRole } from './text';
import { MaterialSymbols } from './MaterialSymbols';
import {
  HeaderActionButton,
  HeaderBackButton,
  ScreenChromeBar,
  ScreenInlineInput,
  ScreenIconButton,
  ScreenSegmentedControl,
  ScreenHeaderShell,
  useFloatingHeaderInset,
} from './ScreenShell';
import { useTranslation } from 'react-i18next';
import { screenChromeTokens } from '../../utils/themeTokens';
import { type ModelsCatalogTab } from '@/store/modelsCatalogTabs';
import type { AndroidBlurTargetRef } from '@/utils/androidBlur';
import { modelCatalogFloatingChrome } from '@/components/models/modelCatalogLayout';

interface SearchHeaderProps {
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeTab: ModelsCatalogTab;
  onTabChange: (tab: ModelsCatalogTab) => void;
  onBack?: () => void;
  onOpenStorage?: () => void;
  floatingControls?: ReactNode;
  onControlsContentOffsetChange?: (offset: number) => void;
}

export const SearchHeader: React.FC<SearchHeaderProps> = ({
  androidContentBlurTargetRef,
  searchQuery,
  onSearchChange,
  activeTab,
  onTabChange,
  onBack,
  onOpenStorage,
  floatingControls,
  onControlsContentOffsetChange,
}) => {
  const { t } = useTranslation();
  const floatingHeaderInset = useFloatingHeaderInset();
  const handleControlsLayout = useCallback((event: LayoutChangeEvent) => {
    onControlsContentOffsetChange?.(
      modelCatalogFloatingChrome.topGap
      + event.nativeEvent.layout.height
      + modelCatalogFloatingChrome.filterToContentGap,
    );
  }, [onControlsContentOffsetChange]);
  const tabOptions = [
    {
      key: 'all',
      label: t('models.tabAllModels'),
      accessibilityLabel: t('models.tabAllModels'),
      testID: 'models-tab-all',
    },
    {
      key: 'downloaded',
      label: t('models.tabDownloaded'),
      accessibilityLabel: t('models.tabDownloaded'),
      testID: 'models-tab-downloaded',
    },
  ] as const;

  return (
    <>
      <ScreenHeaderShell
        testID="models-catalog-header"
        androidBlurTargetRef={androidContentBlurTargetRef}
        contentClassName={screenChromeTokens.headerHorizontalPaddingClassName}
        floating
      >
        <Box className={`${screenChromeTokens.headerContentMinHeightClassName} flex-row items-center ${screenChromeTokens.headerContentGapClassName} ${screenChromeTokens.headerContentVerticalPaddingClassName}`}>
          {onBack ? (
            <HeaderBackButton onPress={onBack} accessibilityLabel={t('chat.headerBackAccessibilityLabel')} />
          ) : null}
          <Box className="min-w-0 flex-1">
            <Text colorRole="primary"
              numberOfLines={1}
              className={composeTextRole('screenTitle')}
            >
              {t('models.catalogTitle')}
            </Text>
          </Box>
          {onOpenStorage ? (
            <HeaderActionButton
              iconName="storage"
              accessibilityLabel={t('settings.storageManager')}
              onPress={onOpenStorage}
              tone="neutral"
            />
          ) : null}
        </Box>
      </ScreenHeaderShell>

      <Box
        testID="models-catalog-controls"
        className={`absolute left-0 right-0 top-0 z-30 mx-auto w-full gap-1.5 ${screenChromeTokens.maxWidthClassName} ${screenChromeTokens.headerHorizontalPaddingClassName}`}
        onLayout={handleControlsLayout}
        style={{
          top: floatingHeaderInset + modelCatalogFloatingChrome.topGap,
          zIndex: 30,
        }}
      >
        <ScreenChromeBar
          testID="models-search-glass"
          androidBlurTargetRef={androidContentBlurTargetRef}
          shape="full"
          className="h-12 rounded-full px-1.5 py-1"
        >
          <ScreenInlineInput
            containerTestID="models-search-input"
            variant="composer"
            embedded
            className="flex-1 border-0 bg-transparent dark:bg-transparent"
            style={styles.transparentInlineInput}
            accessibilityLabel={t('models.searchPlaceholder')}
            placeholder={t('models.searchPlaceholder')}
            value={searchQuery}
            onChangeText={onSearchChange}
            leadingAccessory={<MaterialSymbols colorRole="tertiary" name="search" size="sm" className=" " />}
            trailingAccessory={searchQuery.length > 0 ? (
              <ScreenIconButton
                onPress={() => onSearchChange('')}
                accessibilityLabel={t('common.clear')}
                iconName="close"
                size="compact"
                className="border-0 bg-transparent dark:bg-transparent"
                iconColorRole="tertiary"
              />
            ) : null}
          />
        </ScreenChromeBar>

        <ScreenChromeBar
          testID="models-tabs-glass"
          androidBlurTargetRef={androidContentBlurTargetRef}
          shape="full"
          className="h-10 rounded-full"
        >
          <ScreenSegmentedControl
            testID="models-tab-control"
            activeKey={activeTab}
            onChange={(tab) => onTabChange(tab as ModelsCatalogTab)}
            options={[...tabOptions]}
            density="compact"
            embedded
            className="h-full flex-1 border-0 bg-transparent dark:bg-transparent"
          />
        </ScreenChromeBar>

        {floatingControls}
      </Box>
    </>
  );
};

const styles = StyleSheet.create({
  transparentInlineInput: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
});
