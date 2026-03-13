import React from 'react';
import { Platform } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { BlurView } from 'expo-blur';
import { MaterialSymbols } from './MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ChatHeaderProps {
  title: string;
  memoryLabel: string;
  badgeLabel?: string;
  onBack?: () => void;
  onMenu?: () => void;
}

export const ChatHeader = ({
  title,
  memoryLabel,
  badgeLabel = 'Local Model',
  onBack,
  onMenu,
}: ChatHeaderProps) => {
  const insets = useSafeAreaInsets();
  const containerClassName = "bg-background-0/80 dark:bg-background-950/80";

  const content = (
    <>
      {onBack ? (
        <Pressable
          onPress={onBack}
          className="mr-3 h-10 w-10 items-center justify-center rounded-full active:opacity-70"
        >
          <MaterialSymbols name="arrow-back-ios-new" size={22} className="text-primary-500" />
        </Pressable>
      ) : (
        <Box className="mr-3 h-10 w-10" />
      )}

      <Box className="flex-1">
        <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
          {title}
        </Text>
        <Box className="mt-1 self-start rounded-full bg-primary-500/10 dark:bg-primary-500/20 px-2 py-0.5">
          <Text className="text-2xs font-semibold uppercase tracking-wide text-primary-500">
            {badgeLabel}
          </Text>
        </Box>
      </Box>

      <Box className="flex-row items-center gap-2">
        <Box className="rounded-full border border-primary-500/20 bg-primary-500/10 dark:bg-primary-500/20 px-3 py-1">
          <Text className="text-xs font-semibold text-primary-500">{memoryLabel}</Text>
        </Box>
        <Pressable
          onPress={onMenu}
          className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
        >
          <MaterialSymbols name="more-vert" size={20} className="text-typography-500 dark:text-typography-400" />
        </Pressable>
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
