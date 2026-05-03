import { Tabs } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '../../src/components/ui/box';
import { MaterialSymbols } from '../../src/components/ui/MaterialSymbols';
import type { MaterialSymbolName } from '../../src/components/ui/MaterialSymbols';
import { TabBarGlassBackground } from '../../src/components/ui/TabBarGlassBackground';
import { useTheme } from '../../src/providers/ThemeProvider';
import { createBottomTabBarStyle } from '../../src/utils/tabBarLayout';
import { withAlpha } from '../../src/utils/themeTokens';

export default function TabLayout() {
  const { t } = useTranslation();
  const { colors, appearance } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarStyle = createBottomTabBarStyle(colors, insets.bottom, Platform.OS, appearance);
  const isGlassTabBar = appearance.surfaceKind === 'glass';
  const renderTabIcon = (name: MaterialSymbolName, color: string, focused: boolean) => {
    if (!isGlassTabBar) {
      return <MaterialSymbols size={28} name={name} color={color} />;
    }

    return (
      <Box
        className="h-9 w-11 items-center justify-center overflow-hidden rounded-full"
        style={{
          backgroundColor: focused
            ? withAlpha(colors.primary, 0.13)
            : 'transparent',
        }}
      >
        <LinearGradient
          pointerEvents="none"
          colors={focused
            ? [withAlpha(colors.primary, 0.28), withAlpha(colors.info, 0.16), withAlpha(colors.primaryStrong, 0.1)]
            : ['transparent', 'transparent']}
          locations={focused ? [0, 0.55, 1] : [0, 1]}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <MaterialSymbols size={23} name={name} color={focused ? colors.tabBarActive : color} />
      </Box>
    );
  };

  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        tabBarActiveTintColor: colors.tabBarActive,
        tabBarInactiveTintColor: colors.tabBarInactive,
        headerShown: false,
        tabBarHideOnKeyboard: false,
        tabBarBackground: isGlassTabBar
          ? () => <TabBarGlassBackground key={`${appearance.id}-${colors.headerBlurTint}`} />
          : undefined,
        tabBarStyle,
        tabBarItemStyle: {
          paddingTop: isGlassTabBar ? 6 : 4,
          paddingBottom: isGlassTabBar ? 6 : 4,
        },
        tabBarIconStyle: {
          marginTop: isGlassTabBar ? -1 : -10,
          marginBottom: isGlassTabBar ? 4 : 0,
        },
        tabBarLabelStyle: {
          fontSize: isGlassTabBar ? 11 : 12,
          fontWeight: '600',
          lineHeight: isGlassTabBar ? 13 : undefined,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ color, focused }) => renderTabIcon('home', color, focused),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: t('tabs.chat'),
          tabBarIcon: ({ color, focused }) => renderTabIcon('chat', color, focused),
        }}
      />
      <Tabs.Screen
        name="models"
        options={{
          title: t('tabs.models'),
          tabBarIcon: ({ color, focused }) => renderTabIcon('hub', color, focused),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color, focused }) => renderTabIcon('settings', color, focused),
        }}
      />
    </Tabs>
  );
}
