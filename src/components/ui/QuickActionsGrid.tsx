import React from 'react';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols, MaterialSymbolsProps } from './MaterialSymbols';
import { useMotionPreferences } from '../../hooks/useDeviceMetrics';

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
  const motion = useMotionPreferences();

  return (
    <Box className="flex-row gap-3 pt-6 px-4">
      {actions.map((action, index) => (
        <Animated.View
          key={action.id}
          entering={motion.motionPreset === 'full'
            ? FadeInDown.duration(motion.inlineRevealDurationMs).delay(index * 45)
            : undefined}
          style={{ flex: 1 }}
        >
          <Pressable
            onPress={action.id === 'catalog' ? onCatalogPress : undefined}
            className="min-h-[112px] flex-1 flex-col items-center justify-center rounded-2xl border border-outline-200 bg-background-50 px-4 py-4 active:opacity-80 dark:border-outline-800 dark:bg-background-900/70"
          >
            <Box className="mb-3 h-12 w-12 items-center justify-center rounded-full bg-primary-500/10">
              <MaterialSymbols name={action.icon} size={24} className="text-primary-500 dark:text-primary-300" />
            </Box>
            <Text className="text-center text-xs font-semibold text-typography-700 dark:text-typography-300">
              {action.label}
            </Text>
          </Pressable>
        </Animated.View>
      ))}
    </Box>
  );
};
