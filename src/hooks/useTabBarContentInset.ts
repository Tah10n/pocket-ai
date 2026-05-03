import React from 'react';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../providers/ThemeProvider';
import { bottomTabBarMetrics, isFloatingTabBar } from '../utils/tabBarLayout';
import { useFloatingHeaderInset } from '../components/ui/ScreenShell';
import { getNativeBottomSafeAreaInset } from '../utils/safeArea';

const SafeBottomTabBarHeightContext = BottomTabBarHeightContext
  || React.createContext<number | undefined>(undefined);

export function useTabBarContentInset(): number {
  const { appearance } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarContextHeight = React.useContext(SafeBottomTabBarHeightContext);
  const isFloating = isFloatingTabBar(appearance);
  const nativeBottomInset = getNativeBottomSafeAreaInset(insets.bottom, Platform.OS);
  const tabBarHeight = tabBarContextHeight ?? (
    isFloating
      ? bottomTabBarMetrics.glassHeight
      : bottomTabBarMetrics.height + nativeBottomInset
  );

  return isFloating
    ? tabBarHeight + nativeBottomInset + bottomTabBarMetrics.floatingBottomGap
    : 0;
}

export function useFloatingScrollInsets() {
  return {
    paddingTop: useFloatingHeaderInset(),
    paddingBottom: useTabBarContentInset(),
  };
}
