import React, { useMemo } from 'react';
import { ImageBackground } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';

interface ActiveModelHeroCardProps {
  name: string;
  fitsInRam: boolean;
  memoryUsedGB: number;
  memoryTotalGB: number;
  onChat?: () => void;
  onUnload?: () => void;
}

export const ActiveModelHeroCard = ({
  name,
  fitsInRam,
  memoryUsedGB,
  memoryTotalGB,
  onChat,
  onUnload,
}: ActiveModelHeroCardProps) => {
  const usedPercent = useMemo(() => {
    if (memoryTotalGB <= 0) return 0;
    return Math.min(100, Math.max(0, (memoryUsedGB / memoryTotalGB) * 100));
  }, [memoryUsedGB, memoryTotalGB]);

  return (
    <Box className="rounded-2xl overflow-hidden border border-outline-200 dark:border-outline-800 bg-background-50 dark:bg-background-900/40">
      <ImageBackground
        source={{ uri: "https://lh3.googleusercontent.com/aida-public/AB6AXuBgeacQzvDee5FRz4IolAFCYeRdjSi5o964zo1nH9_1RSd9jOXPsbeN7v2xGEizVFs5ap4YlxkkTvYwU7gAsmGYx5fdjy-EXVSDSplqL6g442DP_jqpWlBitLu19YImIfHJbZYQpZv3VcFmqTpeZ_4PyHInFynYgjtublbwQyS1CMUs9W381FQ7AEcDpX-74bUZcI2DZBNIMXsm5MVuPa4uPRBjhiiHrtM3aM-1xahPOz-5J7NEKxdVQg4hCDW573lexS2Kb4VbxWDV" }}
        className="h-36 w-full"
      >
        <Box className="absolute inset-0 bg-primary-500/15" />
        <Box className="absolute inset-0 bg-background-50/60 dark:bg-background-900/70" />
        <Box className="flex-1 justify-between p-4">
          <Box className="flex-row items-center gap-2">
            <Box className="w-2 h-2 rounded-full bg-success-500" />
            <Text className="text-xs font-semibold uppercase tracking-wide text-success-400">Active</Text>
          </Box>
          <Box className="flex-row items-center gap-2">
            <MaterialSymbols name="memory" size={16} className="text-typography-0" />
            <Text className="text-xs text-typography-0">{memoryUsedGB.toFixed(1)}GB RAM</Text>
          </Box>
        </Box>
      </ImageBackground>

      <Box className="p-4 gap-4">
        <Box className="flex-row items-center justify-between">
          <Box className="flex-1 pr-3">
            <Text className="text-lg font-bold text-typography-900 dark:text-typography-100" numberOfLines={1}>
              {name}
            </Text>
            <Box className="mt-2 flex-row items-center gap-2">
              <Box className="rounded-full bg-success-500/15 px-2 py-0.5">
                <Text className="text-xs font-semibold text-success-600 dark:text-success-300">Active</Text>
              </Box>
              <Box className={`rounded-full px-2 py-0.5 ${fitsInRam ? 'bg-success-500/15' : 'bg-warning-500/15'}`}>
                <Text className={`text-xs font-semibold ${fitsInRam ? 'text-success-500' : 'text-warning-500'}`}>
                  {fitsInRam ? 'Fits in RAM' : 'Heavy Load'}
                </Text>
              </Box>
            </Box>
          </Box>
          <Box className="items-end">
            <Text className="text-xs uppercase tracking-wide text-typography-500 dark:text-typography-400">
              Memory Occupancy
            </Text>
            <Text className="text-sm font-semibold text-typography-900 dark:text-typography-100">
              {memoryUsedGB.toFixed(1)}GB / {memoryTotalGB.toFixed(0)}GB
            </Text>
          </Box>
        </Box>

        <Box className="h-2 rounded-full bg-background-200 dark:bg-background-800 overflow-hidden">
          <Box className="h-full bg-primary-500" style={{ width: `${usedPercent}%` }} />
        </Box>

        <Box className="flex-row gap-3">
          <Pressable
            onPress={onChat}
            className="flex-1 h-10 items-center justify-center rounded-lg bg-primary-500 active:opacity-90"
          >
            <Text className="text-typography-0 text-sm font-semibold">Chat</Text>
          </Pressable>
          <Pressable
            onPress={onUnload}
            className="flex-1 h-10 items-center justify-center rounded-lg bg-background-100 dark:bg-background-800 border border-outline-200 dark:border-outline-700 active:opacity-70"
          >
            <Text className="text-typography-900 dark:text-typography-100 text-sm font-semibold">Unload</Text>
          </Pressable>
        </Box>
      </Box>
    </Box>
  );
};
