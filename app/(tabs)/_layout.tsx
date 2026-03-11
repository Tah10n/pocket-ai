import { Tabs } from 'expo-router';
import React from 'react';
import { useColorScheme } from 'react-native';
import { MaterialSymbols } from '../../src/components/ui/MaterialSymbols';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#3211d4', // primary-500
        tabBarInactiveTintColor: '#64748b', // typography-500
        headerShown: false,
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
          title: 'Home',
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="home" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="chat" color={color} />,
        }}
      />
      <Tabs.Screen
        name="models"
        options={{
          title: 'Models',
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="hub" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="settings" color={color} />,
        }}
      />
    </Tabs>
  );
}
