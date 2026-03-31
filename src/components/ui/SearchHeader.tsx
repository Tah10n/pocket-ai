import React from 'react';
import { Box } from './box';
import { Text, composeTextRole } from './text';
import { MaterialSymbols } from './MaterialSymbols';
import {
  HeaderActionButton,
  HeaderActionPlaceholder,
  HeaderBackButton,
  ScreenInlineInput,
  ScreenIconButton,
  ScreenSegmentedControl,
  ScreenHeaderShell,
} from './ScreenShell';
import { useTranslation } from 'react-i18next';
import { screenChromeTokens } from '../../utils/themeTokens';
import { type ModelsCatalogTab } from '../models/modelTabs';

interface SearchHeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeTab: ModelsCatalogTab;
  onTabChange: (tab: ModelsCatalogTab) => void;
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
    <ScreenHeaderShell contentClassName={`${screenChromeTokens.headerHorizontalPaddingClassName} pb-2 pt-1`}>
      <Box className={`flex-row items-center ${screenChromeTokens.headerContentGapClassName} py-0.5`}>
        <HeaderBackButton onPress={onBack} accessibilityLabel={t('chat.headerBackAccessibilityLabel')} />
        <Box className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={composeTextRole('screenTitle', 'text-[20px] leading-6')}
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
        ) : (
          <HeaderActionPlaceholder />
        )}
      </Box>

      <ScreenInlineInput
        variant="search"
        className="mt-2"
        accessibilityLabel={t('models.searchPlaceholder')}
        placeholder={t('models.searchPlaceholder')}
        value={searchQuery}
        onChangeText={onSearchChange}
        leadingAccessory={<MaterialSymbols name="search" size={17} className="text-typography-500 dark:text-typography-400" />}
        trailingAccessory={searchQuery.length > 0 ? (
          <ScreenIconButton
            onPress={() => onSearchChange('')}
            accessibilityLabel={t('common.clear')}
            iconName="close"
            size="compact"
            className="border-0 bg-transparent dark:bg-transparent"
            iconClassName="text-typography-400"
          />
        ) : null}
      />

      <ScreenSegmentedControl
        testID="models-tab-control"
        className="mt-2"
        activeKey={activeTab}
        onChange={(tab) => onTabChange(tab as ModelsCatalogTab)}
        options={[...tabOptions]}
      />
    </ScreenHeaderShell>
  );
};
