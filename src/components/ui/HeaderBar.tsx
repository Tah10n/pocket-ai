import React from 'react';
import { Platform } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { Image } from '@/components/ui/image';
import { BlurView } from 'expo-blur';
import { MaterialSymbols } from './MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface HeaderBarProps {
  title: string;
  onBack?: () => void;
  showProfile?: boolean;
}

export const HeaderBar = ({ title, onBack, showProfile = false }: HeaderBarProps) => {
  const insets = useSafeAreaInsets();
  const sideWidth = showProfile ? 96 : 40;
  const containerClassName = "bg-background-0/80 dark:bg-background-950/80";

  const content = (
    <>
      <Box style={{ width: sideWidth }} className="items-start justify-center">
        {onBack ? (
          <Pressable onPress={onBack} className="active:opacity-70">
            <MaterialSymbols name="arrow-back-ios-new" size={24} className="text-primary-500" />
          </Pressable>
        ) : (
          <Box className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-500/10">
            <MaterialSymbols name="terminal" size={24} className="text-primary-500" />
          </Box>
        )}
      </Box>

      <Box className="flex-1 items-center px-2">
        <Text className="text-xl font-bold tracking-tight text-typography-900 dark:text-typography-100">
          {title}
        </Text>
      </Box>

      <Box style={{ width: sideWidth }} className="flex-row items-center justify-end gap-3">
        <Pressable className="flex h-10 w-10 items-center justify-center rounded-lg active:opacity-70 active:bg-primary-500/10">
          <MaterialSymbols name="search" size={24} className="text-typography-500 dark:text-typography-400" />
        </Pressable>
        {showProfile && (
          <Box className="w-8 h-8 rounded-full bg-primary-500/20 items-center justify-center overflow-hidden border border-primary-500/30">
            <Image
              source={{ uri: "https://lh3.googleusercontent.com/aida-public/AB6AXuCqNWAZMZvtAQjBF9FQ-Ymu-tSmuLeRqqO16vZ41k3qnCZPlJZqKWaP1u4vCa4uM7MoFx4hwH84T6aSbztQ7kelrlnuqttZlqDr7ldshimP6SG0HqhlsHDhrB1WXbixUYFbs_8g3lEsddq3PrhcVEB5PYPEyFfAIuQJsHdTQZmquJwhGl1jtML0VjHph_H2ZOOawzZvR0J5lfOfs87hUpid8PY0Aa_fafpFYooVluOzKdEBNW1zox2_6HhqhHPt88ZG_kyV9wNzjIh-" }}
              alt="Profile Picture"
              className="w-full h-full object-cover"
            />
          </Box>
        )}
      </Box>
    </>
  );

  return (
    <Box className="z-10 w-full overflow-hidden border-b border-outline-200 dark:border-outline-800">
      {Platform.OS === 'android' ? (
        <Box className={containerClassName} style={{ paddingTop: insets.top }}>
          <Box className="h-14 flex-row items-center px-4">{content}</Box>
        </Box>
      ) : (
        <BlurView
          intensity={80}
          tint="default"
          className={containerClassName}
          style={{ paddingTop: insets.top }}
        >
          <Box className="h-14 flex-row items-center px-4">{content}</Box>
        </BlurView>
      )}
    </Box>
  );
};
