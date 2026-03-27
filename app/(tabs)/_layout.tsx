import { Tabs } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialSymbols } from '../../src/components/ui/MaterialSymbols';
import { useTheme } from '../../src/providers/ThemeProvider';

export default function TabLayout() {
  const { t } = useTranslation();
  const { resolvedMode } = useTheme();
  const isDark = resolvedMode === 'dark';
  const tabBarStyle = {
    height: 72,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: isDark ? 'rgba(19, 16, 34, 0.96)' : 'rgba(246, 246, 248, 0.96)',
    borderTopColor: isDark ? 'rgba(148, 163, 184, 0.14)' : 'rgba(100, 116, 139, 0.12)',
    borderTopWidth: 1,
    elevation: 0,
    shadowOpacity: 0,
  } as const;

  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        tabBarActiveTintColor: '#3211d4', // primary-500
        tabBarInactiveTintColor: '#64748b', // typography-500
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarStyle,
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
          tabBarStyle: {
            display: 'none',
          },
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
