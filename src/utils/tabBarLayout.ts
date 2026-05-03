import type { ViewStyle } from 'react-native';
import type { ThemeAppearance, ThemeColors } from './themeTokens';
import { getNativeBottomSafeAreaInset, type AppPlatform } from './safeArea';

export const bottomTabBarMetrics = {
  height: 74,
  glassHeight: 76,
  floatingHorizontalInset: 14,
  floatingBottomGap: 10,
  glassRadius: 34,
  paddingTop: 8,
  glassPaddingTop: 6,
  paddingBottom: 12,
  glassPaddingBottom: 10,
} as const;

type TabBarColors = Pick<ThemeColors, 'tabBarBackground' | 'tabBarBorder'>;

export function isFloatingTabBar(appearance?: Pick<ThemeAppearance, 'surfaceKind'>) {
  return appearance?.surfaceKind === 'glass';
}

export function createBottomTabBarStyle(
  colors: TabBarColors,
  bottomSafeAreaInset: number,
  platform: AppPlatform,
  appearance?: Pick<ThemeAppearance, 'id' | 'surfaceKind' | 'effects'>,
): ViewStyle {
  const nativeBottomInset = getNativeBottomSafeAreaInset(bottomSafeAreaInset, platform);
  const isGlass = isFloatingTabBar(appearance);
  const tabBarHeight = isGlass ? bottomTabBarMetrics.glassHeight : bottomTabBarMetrics.height;
  const tabBarPaddingTop = isGlass ? bottomTabBarMetrics.glassPaddingTop : bottomTabBarMetrics.paddingTop;
  const tabBarPaddingBottom = isGlass ? bottomTabBarMetrics.glassPaddingBottom : bottomTabBarMetrics.paddingBottom;

  return {
    ...(isGlass ? {
      position: 'absolute',
      left: bottomTabBarMetrics.floatingHorizontalInset,
      right: bottomTabBarMetrics.floatingHorizontalInset,
      bottom: nativeBottomInset + bottomTabBarMetrics.floatingBottomGap,
      borderRadius: bottomTabBarMetrics.glassRadius,
      overflow: 'hidden',
    } : {}),
    height: isGlass ? tabBarHeight : tabBarHeight + nativeBottomInset,
    paddingTop: tabBarPaddingTop,
    paddingBottom: isGlass ? tabBarPaddingBottom : tabBarPaddingBottom + nativeBottomInset,
    backgroundColor: isGlass ? 'transparent' : colors.tabBarBackground,
    borderTopColor: colors.tabBarBorder,
    borderTopWidth: isGlass ? 0 : 1,
    elevation: 0,
    shadowOpacity: 0,
    ...appearance?.effects.tabBarStyle,
  };
}
