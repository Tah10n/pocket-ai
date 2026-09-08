import { Tabs } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '../../src/components/ui/box';
import { MaterialSymbols } from '../../src/components/ui/MaterialSymbols';
import type { MaterialSymbolName } from '../../src/components/ui/MaterialSymbols';
import { TabBarMaterialBackground } from '../../src/components/ui/TabBarMaterialBackground';
import { useTheme } from '../../src/providers/ThemeProvider';
import { createBottomTabBarStyle } from '../../src/utils/tabBarLayout';
import { withAlpha } from '../../src/utils/themeTokens';
import { hasActiveChatGenerationWork } from '../../src/services/ChatGenerationService';

export default function TabLayout() {
  const { t } = useTranslation();
  const { colors, resolvedTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarPresentation = resolvedTheme.components.tabBar.presentation;
  const tabBarStyle = createBottomTabBarStyle(colors, insets.bottom, Platform.OS, tabBarPresentation);
  const isFloatingTabBar = tabBarPresentation === 'floating';
  const preventBusyTabNavigation = React.useCallback((event: { preventDefault: () => void }) => {
    if (hasActiveChatGenerationWork()) {
      event.preventDefault();
    }
  }, []);
  const renderTabIcon = (name: MaterialSymbolName, color: string, focused: boolean) => {
    if (!isFloatingTabBar) {
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
        tabBarBackground: isFloatingTabBar
          ? () => <TabBarMaterialBackground key={`${resolvedTheme.id}-${resolvedTheme.mode}`} />
          : undefined,
        tabBarStyle,
        tabBarItemStyle: {
          paddingTop: isFloatingTabBar ? 6 : 4,
          paddingBottom: isFloatingTabBar ? 6 : 4,
        },
        tabBarIconStyle: {
          marginTop: isFloatingTabBar ? -1 : -10,
          marginBottom: isFloatingTabBar ? 4 : 0,
        },
        tabBarLabelStyle: {
          fontSize: isFloatingTabBar ? 11 : 12,
          fontWeight: '600',
          lineHeight: isFloatingTabBar ? 13 : undefined,
        },
      }}>
      <Tabs.Screen
        name="index"
        listeners={{ tabPress: preventBusyTabNavigation }}
        options={{
          title: t('tabs.home'),
          tabBarAccessibilityLabel: t('tabs.home'),
          tabBarButtonTestID: 'bottom-tab-home',
          tabBarIcon: ({ color, focused }) => renderTabIcon('home', color, focused),
        }}
      />
      <Tabs.Screen
        name="chat"
        listeners={{ tabPress: preventBusyTabNavigation }}
        options={{
          title: t('tabs.chat'),
          tabBarAccessibilityLabel: t('tabs.chat'),
          tabBarButtonTestID: 'bottom-tab-chat',
          tabBarIcon: ({ color, focused }) => renderTabIcon('chat', color, focused),
        }}
      />
      <Tabs.Screen
        name="models"
        listeners={{ tabPress: preventBusyTabNavigation }}
        options={{
          title: t('tabs.models'),
          tabBarAccessibilityLabel: t('tabs.models'),
          tabBarButtonTestID: 'bottom-tab-models',
          tabBarIcon: ({ color, focused }) => renderTabIcon('hub', color, focused),
        }}
      />
      <Tabs.Screen
        name="settings"
        listeners={{ tabPress: preventBusyTabNavigation }}
        options={{
          title: t('tabs.settings'),
          tabBarAccessibilityLabel: t('tabs.settings'),
          tabBarButtonTestID: 'bottom-tab-settings',
          tabBarIcon: ({ color, focused }) => renderTabIcon('settings', color, focused),
        }}
      />
    </Tabs>
  );
}
