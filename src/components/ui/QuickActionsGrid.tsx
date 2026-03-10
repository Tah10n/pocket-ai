import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { MaterialSymbols } from './MaterialSymbols';

const actions = [
  { id: 'catalog', icon: 'library-books', label: 'Catalog' },
  { id: 'presets', icon: 'tune', label: 'Presets' },
  { id: 'config', icon: 'settings', label: 'Config' },
];

interface QuickActionsGridProps {
  onCatalogPress?: () => void;
}

export const QuickActionsGrid = ({ onCatalogPress }: QuickActionsGridProps) => {
  return (
    <View className="flex-row gap-3 pt-6 px-4">
      {actions.map((action) => (
        <Pressable
          key={action.id}
          onPress={action.id === 'catalog' ? onCatalogPress : undefined}
          style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1, backgroundColor: pressed ? 'rgba(50, 17, 212, 0.05)' : 'transparent' }]}
          className="flex-1 flex-col items-center justify-center p-4 rounded-xl bg-white dark:bg-primary/5 border border-slate-200 dark:border-primary/10"
        >

          <View className="w-12 h-12 rounded-full bg-primary/10 items-center justify-center mb-2">
            <MaterialSymbols name={action.icon} size={24} className="text-primary dark:text-slate-300" />
          </View>
          <Text className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
};
