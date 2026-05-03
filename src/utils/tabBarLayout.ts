import type { ViewStyle } from 'react-native';
import type { ThemeColors } from './themeTokens';
import { getNativeBottomSafeAreaInset, type AppPlatform } from './safeArea';

export const bottomTabBarMetrics = {
  height: 74,
  paddingTop: 8,
  paddingBottom: 12,
} as const;

type TabBarColors = Pick<ThemeColors, 'tabBarBackground' | 'tabBarBorder'>;

export function createBottomTabBarStyle(
  colors: TabBarColors,
  bottomSafeAreaInset: number,
  platform: AppPlatform,
): ViewStyle {
  const nativeBottomInset = getNativeBottomSafeAreaInset(bottomSafeAreaInset, platform);

  return {
    height: bottomTabBarMetrics.height + nativeBottomInset,
    paddingTop: bottomTabBarMetrics.paddingTop,
    paddingBottom: bottomTabBarMetrics.paddingBottom + nativeBottomInset,
    backgroundColor: colors.tabBarBackground,
    borderTopColor: colors.tabBarBorder,
    borderTopWidth: 1,
    elevation: 0,
    shadowOpacity: 0,
  };
}
