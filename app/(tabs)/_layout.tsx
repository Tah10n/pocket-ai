import { Tabs } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MaterialSymbols } from '../../src/components/ui/MaterialSymbols';
import { useTheme } from '../../src/providers/ThemeProvider';

export default function TabLayout() {
  const { t } = useTranslation();
  const { resolvedMode } = useTheme();
  const isDark = resolvedMode === 'dark';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#3211d4', // primary-500
        tabBarInactiveTintColor: '#64748b', // typography-500
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
            backgroundColor: isDark ? 'rgba(19, 16, 34, 0.9)' : 'rgba(246, 246, 248, 0.9)',
            borderTopColor: isDark ? 'rgba(50, 17, 212, 0.2)' : 'rgba(50, 17, 212, 0.1)',
            elevation: 0,
            shadowOpacity: 0,
        }
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
