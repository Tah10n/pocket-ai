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
  statusLabel?: string;
  detailLabel?: string;
  canStartNewChat?: boolean;
  onStartNewChat?: () => void;
  onOpenModelControls?: () => void;
  canOpenModelControls?: boolean;
  onBack?: () => void;
  onMenu?: () => void;
}

export const ChatHeader = ({
  title,
  memoryLabel,
  badgeLabel = 'Local Model',
  statusLabel,
  detailLabel,
  canStartNewChat = true,
  onStartNewChat,
  onOpenModelControls,
  canOpenModelControls = true,
  onBack,
  onMenu,
}: ChatHeaderProps) => {
  const insets = useSafeAreaInsets();
  const containerClassName = "bg-background-0/80 dark:bg-background-950/80";
  const metadataTextClassName = 'text-xs text-typography-500 dark:text-typography-400';

  const content = (
    <Box className="flex-row items-start px-4 py-3">
      {onBack ? (
        <Pressable
          onPress={onBack}
          className="mr-3 h-10 w-10 shrink-0 items-center justify-center rounded-full active:opacity-70"
        >
          <MaterialSymbols name="arrow-back-ios-new" size={22} className="text-primary-500" />
        </Pressable>
      ) : (
        <Box className="mr-3 h-10 w-10 shrink-0" />
      )}

      <Box className="min-w-0 flex-1">
        <Box className="flex-row items-start gap-3">
          <Box className="min-w-0 flex-1">
            <Text
              numberOfLines={1}
              className="text-base font-semibold text-typography-900 dark:text-typography-100"
            >
              {title}
            </Text>
            <Box className="mt-1 flex-row flex-wrap items-center gap-2">
              <Box className="max-w-full shrink rounded-full bg-primary-500/10 dark:bg-primary-500/20 px-2 py-0.5">
                <Text
                  numberOfLines={1}
                  className="text-2xs font-semibold uppercase tracking-wide text-primary-500"
                >
                  {badgeLabel}
                </Text>
              </Box>
              <Box className="max-w-full shrink rounded-full border border-primary-500/20 bg-primary-500/10 dark:bg-primary-500/20 px-3 py-1">
                <Text numberOfLines={1} className="text-xs font-semibold text-primary-500">
                  {memoryLabel}
                </Text>
              </Box>
              {statusLabel ? (
                <Text numberOfLines={1} className={metadataTextClassName}>
                  {statusLabel}
                </Text>
              ) : null}
            </Box>
            {detailLabel ? (
              <Text numberOfLines={1} className={`mt-1 ${metadataTextClassName}`}>
                {detailLabel}
              </Text>
            ) : null}
          </Box>

          <Box className="shrink-0 flex-row items-center gap-2">
            {onOpenModelControls ? (
              <Pressable
                onPress={onOpenModelControls}
                disabled={!canOpenModelControls}
                className={`h-9 w-9 items-center justify-center rounded-full ${canOpenModelControls
                  ? 'border border-primary-500/20 bg-primary-500/10 active:opacity-70'
                  : 'bg-background-100 dark:bg-background-900/60'}`}
              >
                <MaterialSymbols
                  name="tune"
                  size={18}
                  className={canOpenModelControls ? 'text-primary-500' : 'text-typography-400 dark:text-typography-500'}
                />
              </Pressable>
            ) : null}
            {canStartNewChat ? (
              <Pressable
                onPress={onStartNewChat}
                className="h-9 w-9 items-center justify-center rounded-full border border-primary-500/20 bg-primary-500/10 active:opacity-70"
              >
                <MaterialSymbols name="edit-square" size={18} className="text-primary-500" />
              </Pressable>
            ) : null}
            <Pressable
              onPress={onMenu}
              className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
            >
              <MaterialSymbols name="more-vert" size={20} className="text-typography-500 dark:text-typography-400" />
            </Pressable>
          </Box>
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box className="z-10 w-full overflow-hidden border-b border-outline-200 dark:border-outline-800">
      {Platform.OS === 'android' ? (
        <Box className={containerClassName} style={{ paddingTop: insets.top }}>
          {content}
        </Box>
      ) : (
        <BlurView
          intensity={80}
          tint="default"
          className={containerClassName}
          style={{ paddingTop: insets.top }}
        >
          {content}
        </BlurView>
      )}
    </Box>
  );
};
