import React from 'react';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { type MaterialSymbolsProps } from './MaterialSymbols';
import { ScreenIconTile, ScreenPressableCard } from './ScreenShell';
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
          <ScreenPressableCard
            onPress={action.id === 'catalog' ? onCatalogPress : undefined}
            padding="none"
            className="min-h-[112px] flex-1 flex-col items-center justify-center px-4 py-4"
          >
            <ScreenIconTile iconName={action.icon} tone="accent" size="lg" iconSize={24} className="mb-3 h-12 w-12 rounded-full" />
            <Text className="text-center text-xs font-semibold text-typography-700 dark:text-typography-300">
              {action.label}
            </Text>
          </ScreenPressableCard>
        </Animated.View>
      ))}
    </Box>
  );
};
