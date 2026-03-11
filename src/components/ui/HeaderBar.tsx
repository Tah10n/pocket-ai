import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Image } from '@/components/ui/image';
import { BlurView } from 'expo-blur';
import { MaterialSymbols } from './MaterialSymbols';

interface HeaderBarProps {
  title: string;
  onBack?: () => void;
  showProfile?: boolean;
}

export const HeaderBar = ({ title, onBack, showProfile = false }: HeaderBarProps) => {
  return (
    <Box className="sticky top-0 z-10 w-full overflow-hidden border-b border-outline-200 dark:border-outline-800">
      <BlurView intensity={80} tint="default" className="flex-row items-center justify-between px-4 py-4 bg-background-light/80 dark:bg-background-dark/80">
        <Box className="flex-row items-center gap-3">
            {onBack ? (
                <Pressable 
                    onPress={onBack} 
                    className="active:opacity-70"
                >
                    <MaterialSymbols name="arrow-back-ios-new" size={24} className="text-primary-500" />
                </Pressable>
            ) : (
                <Box className="flex w-10 h-10 items-center justify-center rounded-full bg-primary-500/10">
                    <MaterialSymbols name="terminal" size={24} className="text-primary-500" />
                </Box>
            )}
            
            <Text className={`text-xl font-bold tracking-tight text-typography-900 dark:text-typography-100 ${!onBack ? 'flex-1 text-center' : ''}`}>
                {title}
            </Text>
        </Box>

        <Box className="flex-row items-center gap-4">
            <Pressable 
                className="flex h-10 w-10 items-center justify-center rounded-lg active:opacity-70 active:bg-primary-500/10"
            >
                <MaterialSymbols name="search" size={24} className="text-typography-500 dark:text-typography-400" />
            </Pressable>
            {showProfile && (
                <Box className="w-8 h-8 rounded-full bg-primary-500/20 items-center justify-center overflow-hidden border border-primary-500/30">
                    <Image source={{ uri: "https://lh3.googleusercontent.com/aida-public/AB6AXuCqNWAZMZvtAQjBF9FQ-Ymu-tSmuLeRqqO16vZ41k3qnCZPlJZqKWaP1u4vCa4uM7MoFx4hwH84T6aSbztQ7kelrlnuqttZlqDr7ldshimP6SG0HqhlsHDhrB1WXbixUYFbs_8g3lEsddq3PrhcVEB5PYPEyFfAIuQJsHdTQZmquJwhGl1jtML0VjHph_H2ZOOawzZvR0J5lfOfs87hUpid8PY0Aa_fafpFYooVluOzKdEBNW1zox2_6HhqhHPt88ZG_kyV9wNzjIh-"}} alt="Profile Picture" className="w-full h-full object-cover" />
                </Box>
            )}
        </Box>
      </BlurView>
    </Box>
  );
};
