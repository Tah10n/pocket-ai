import { Tabs } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialSymbols } from '../../src/components/ui/MaterialSymbols';
import { useTheme } from '../../src/providers/ThemeProvider';
import { createBottomTabBarStyle } from '../../src/utils/tabBarLayout';

export default function TabLayout() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarStyle = createBottomTabBarStyle(colors, insets.bottom, Platform.OS);

  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        tabBarActiveTintColor: colors.tabBarActive,
        tabBarInactiveTintColor: colors.tabBarInactive,
        headerShown: false,
        tabBarHideOnKeyboard: false,
        tabBarStyle,
        tabBarItemStyle: {
          paddingVertical: 4,
        },
        tabBarIconStyle: {
          marginTop: -10,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: t('tabs.chat'),
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="chat" color={color} />,
        }}
      />
      <Tabs.Screen
        name="models"
        options={{
          title: t('tabs.models'),
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="hub" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="settings" color={color} />,
        }}
      />
    </Tabs>
  );
}
