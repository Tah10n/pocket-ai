import type { ViewStyle } from 'react-native';
import type { ThemeColors } from './themeTokens';
import { getNativeBottomSafeAreaInset, type AppPlatform } from './safeArea';

export const bottomTabBarMetrics = {
  height: 74,
  floatingHeight: 76,
  floatingHorizontalInset: 14,
  floatingBottomGap: 10,
  floatingRadius: 34,
  paddingTop: 8,
  floatingPaddingTop: 6,
  paddingBottom: 12,
  floatingPaddingBottom: 10,
} as const;

type TabBarColors = Pick<ThemeColors, 'tabBarBackground' | 'tabBarBorder'>;

export type TabBarPresentation = 'attached' | 'floating';

export function isFloatingTabBar(presentation: TabBarPresentation = 'attached') {
  return presentation === 'floating';
}

export function createBottomTabBarStyle(
  colors: TabBarColors,
  bottomSafeAreaInset: number,
  platform: AppPlatform,
  presentation: TabBarPresentation = 'attached',
): ViewStyle {
  const nativeBottomInset = getNativeBottomSafeAreaInset(bottomSafeAreaInset, platform);
  const isFloating = isFloatingTabBar(presentation);
  const tabBarHeight = isFloating ? bottomTabBarMetrics.floatingHeight : bottomTabBarMetrics.height;
  const tabBarPaddingTop = isFloating ? bottomTabBarMetrics.floatingPaddingTop : bottomTabBarMetrics.paddingTop;
  const tabBarPaddingBottom = isFloating ? bottomTabBarMetrics.floatingPaddingBottom : bottomTabBarMetrics.paddingBottom;

  return {
    ...(isFloating ? {
      position: 'absolute',
      left: bottomTabBarMetrics.floatingHorizontalInset,
      right: bottomTabBarMetrics.floatingHorizontalInset,
      bottom: nativeBottomInset + bottomTabBarMetrics.floatingBottomGap,
      borderRadius: bottomTabBarMetrics.floatingRadius,
      overflow: 'hidden',
    } : {}),
    height: isFloating ? tabBarHeight : tabBarHeight + nativeBottomInset,
    paddingTop: tabBarPaddingTop,
    paddingBottom: isFloating ? tabBarPaddingBottom : tabBarPaddingBottom + nativeBottomInset,
    backgroundColor: isFloating ? 'transparent' : colors.tabBarBackground,
    borderTopColor: colors.tabBarBorder,
    borderTopWidth: isFloating ? 0 : 1,
    elevation: 0,
    shadowOpacity: 0,
  };
}
