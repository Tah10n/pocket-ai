import { Tabs } from 'expo-router';
import React from 'react';
import { MaterialSymbols } from '../../src/components/ui/MaterialSymbols';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#3211d4',
        tabBarInactiveTintColor: '#64748b',
        headerShown: false,
        tabBarStyle: {
            backgroundColor: 'rgba(246, 246, 248, 0.9)',
            borderTopColor: 'rgba(50, 17, 212, 0.1)',
            elevation: 0,
            shadowOpacity: 0,
        }
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="home" color={color} style={{ color }} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="chat" color={color} style={{ color }} />,
        }}
      />
      <Tabs.Screen
        name="models"
        options={{
          title: 'Models',
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="hub" color={color} style={{ color }} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <MaterialSymbols size={28} name="settings" color={color} style={{ color }} />,
        }}
      />
    </Tabs>
  );
}
