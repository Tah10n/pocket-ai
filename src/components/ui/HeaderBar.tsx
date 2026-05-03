import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { MaterialSymbols } from './MaterialSymbols';
import {
  HeaderActionPlaceholder,
  HeaderBackButton,
  HeaderTitleBlock,
  ScreenHeaderShell,
  ScreenIconTile,
} from './ScreenShell';
import { screenChromeTokens } from '../../utils/themeTokens';

interface HeaderBarProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backAccessibilityLabel?: string;
  backButtonTestID?: string;
  rightAccessory?: React.ReactNode;
  showBrand?: boolean;
  brandIconName?: React.ComponentProps<typeof MaterialSymbols>['name'];
  titleLines?: number;
}

export const HeaderBar = ({
  title,
  subtitle,
  onBack,
  backAccessibilityLabel,
  backButtonTestID,
  rightAccessory,
  showBrand = false,
  brandIconName = 'terminal',
  titleLines = 2,
}: HeaderBarProps) => {
  const { t } = useTranslation();
  const resolvedBackAccessibilityLabel = backAccessibilityLabel ?? t('chat.headerBackAccessibilityLabel');
  return (
    <ScreenHeaderShell contentClassName={screenChromeTokens.headerHorizontalPaddingClassName}>
      <Box className={`${screenChromeTokens.headerContentMinHeightClassName} flex-row items-center ${screenChromeTokens.headerContentGapClassName} ${screenChromeTokens.headerContentVerticalPaddingClassName}`}>
        {onBack ? (
          <HeaderBackButton
            testID={backButtonTestID}
            onPress={onBack}
            accessibilityLabel={resolvedBackAccessibilityLabel}
          />
        ) : showBrand ? (
          <ScreenIconTile iconName={brandIconName} tone="accent" iconSize="xl" className={screenChromeTokens.headerActionClassName} iconClassName="text-primary-500" />
        ) : (
          <HeaderActionPlaceholder />
        )}

        <HeaderTitleBlock title={title} subtitle={subtitle} titleLines={titleLines} />

        {rightAccessory ?? <HeaderActionPlaceholder />}
      </Box>
    </ScreenHeaderShell>
  );
};
