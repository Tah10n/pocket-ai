import { Platform } from 'react-native';

export type AppPlatform = typeof Platform.OS;

export function getNativeBottomSafeAreaInset(
  bottomInset: number,
  platform: AppPlatform = Platform.OS,
) {
  if (platform !== 'android' && platform !== 'ios') {
    return 0;
  }

  return Number.isFinite(bottomInset) ? Math.max(bottomInset, 0) : 0;
}
