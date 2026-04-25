import type { ViewStyle } from 'react-native';
import type { ThemeAppearance, ThemeColors } from './themeTokens';
import { getNativeBottomSafeAreaInset, type AppPlatform } from './safeArea';

export const bottomTabBarMetrics = {
  height: 74,
  paddingTop: 8,
  paddingBottom: 12,
} as const;

type TabBarColors = Pick<ThemeColors, 'tabBarBackground' | 'tabBarBorder'>;
type PlatformVersion = number | string | undefined;

function getAndroidSdkVersion(platform: AppPlatform, platformVersion?: PlatformVersion) {
  if (platform !== 'android') {
    return undefined;
  }

  const parsedVersion = typeof platformVersion === 'string'
    ? Number.parseInt(platformVersion, 10)
    : platformVersion;

  return Number.isFinite(parsedVersion) ? parsedVersion : undefined;
}

function isAndroidBlurFallbackRequired(platform: AppPlatform, platformVersion?: PlatformVersion) {
  const sdkVersion = getAndroidSdkVersion(platform, platformVersion);

  return platform === 'android' && (sdkVersion === undefined || sdkVersion < 31);
}

export function createBottomTabBarStyle(
  colors: TabBarColors,
  bottomSafeAreaInset: number,
  platform: AppPlatform,
  appearance?: Pick<ThemeAppearance, 'id' | 'surfaceKind' | 'effects'>,
  platformVersion?: PlatformVersion,
): ViewStyle {
  const nativeBottomInset = getNativeBottomSafeAreaInset(bottomSafeAreaInset, platform);
  const isGlass = appearance?.surfaceKind === 'glass';
  const shouldUseTransparentGlassBackground = isGlass && !isAndroidBlurFallbackRequired(platform, platformVersion);

  return {
    height: bottomTabBarMetrics.height + nativeBottomInset,
    paddingTop: bottomTabBarMetrics.paddingTop,
    paddingBottom: bottomTabBarMetrics.paddingBottom + nativeBottomInset,
    backgroundColor: shouldUseTransparentGlassBackground ? 'transparent' : colors.tabBarBackground,
    borderTopColor: colors.tabBarBorder,
    borderTopWidth: 1,
    elevation: 0,
    shadowOpacity: 0,
    ...appearance?.effects.tabBarStyle,
  };
}
