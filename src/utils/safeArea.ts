import { Platform } from 'react-native';

export type AppPlatform = typeof Platform.OS;

export function getNativeSafeAreaInset(
  inset: number,
  platform: AppPlatform = Platform.OS,
) {
  if (platform !== 'android' && platform !== 'ios') {
    return 0;
  }

  return Number.isFinite(inset) ? Math.max(inset, 0) : 0;
}

export function getNativeBottomSafeAreaInset(
  bottomInset: number,
  platform: AppPlatform = Platform.OS,
) {
  return getNativeSafeAreaInset(bottomInset, platform);
}
