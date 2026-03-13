import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols, MaterialSymbolsProps } from './MaterialSymbols';

type QuickAction = { id: 'catalog' | 'presets' | 'config'; icon: MaterialSymbolsProps['name']; label: string };

const actions: QuickAction[] = [
  { id: 'catalog', icon: 'library-books', label: 'Catalog' },
  { id: 'presets', icon: 'tune', label: 'Presets' },
  { id: 'config', icon: 'settings', label: 'Config' },
];

interface QuickActionsGridProps {
  onCatalogPress?: () => void;
}

export const QuickActionsGrid = ({ onCatalogPress }: QuickActionsGridProps) => {
  return (
    <Box className="flex-row gap-3 pt-6 px-4">
      {actions.map((action) => (
        <Pressable
          key={action.id}
          onPress={action.id === 'catalog' ? onCatalogPress : undefined}
          className="flex-1 flex-col items-center justify-center p-4 rounded-xl bg-background-50 dark:bg-primary-500/5 border border-outline-200 dark:border-primary-500/10 active:opacity-70 active:bg-primary-500/5"
        >

          <Box className="w-12 h-12 rounded-full bg-primary-500/10 items-center justify-center mb-2">
            <MaterialSymbols name={action.icon} size={24} className="text-primary-500 dark:text-typography-300" />
          </Box>
          <Text className="text-xs font-semibold text-typography-700 dark:text-typography-300">
            {action.label}
          </Text>
        </Pressable>
      ))}
    </Box>
  );
};
