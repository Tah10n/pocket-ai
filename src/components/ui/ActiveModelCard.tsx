import React from 'react';
import { ImageBackground } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { BlurView } from 'expo-blur';
import { MaterialSymbols } from './MaterialSymbols';

interface ActiveModelCardProps {
  onSwapModel?: () => void;
}

export const ActiveModelCard = ({ onSwapModel }: ActiveModelCardProps) => {
  return (
    <Box className="mx-4 mt-4 rounded-xl shadow-xl bg-background-50 dark:bg-primary-500/10 border border-outline-200 dark:border-primary-500/20 overflow-hidden">
      <ImageBackground 
        source={{ uri: "https://lh3.googleusercontent.com/aida-public/AB6AXuBgeacQzvDee5FRz4IolAFCYeRdjSi5o964zo1nH9_1RSd9jOXPsbeN7v2xGEizVFs5ap4YlxkkTvYwU7gAsmGYx5fdjy-EXVSDSplqL6g442DP_jqpWlBitLu19YImIfHJbZYQpZv3VcFmqTpeZ_4PyHInFynYgjtublbwQyS1CMUs9W381FQ7AEcDpX-74bUZcI2DZBNIMXsm5MVuPa4uPRBjhiiHrtM3aM-1xahPOz-5J7NEKxdVQg4hCDW573lexS2Kb4VbxWDV" }} 
        className="w-full aspect-video justify-end"
      >
        <BlurView intensity={20} tint="dark" className="absolute inset-0" />
        <Box className="flex-row items-center gap-2 p-4 pb-3">
          <Box className="w-2 h-2 rounded-full bg-success-500" />
          <Text className="text-xs font-medium text-typography-0 uppercase tracking-widest">System Ready</Text>
        </Box>
      </ImageBackground>

      <Box className="px-4 py-4 gap-1">
        <Text className="text-typography-500 dark:text-typography-400 text-sm font-medium">Active Model</Text>
        <Box className="flex-row items-baseline gap-2">
            <Text className="text-typography-900 dark:text-typography-100 text-xl font-bold tracking-tight">Llama 3 8B</Text>
            <Box className="px-2 py-0.5 bg-primary-500/20 rounded-full">
                <Text className="text-xs font-normal text-primary-500">Instruct</Text>
            </Box>
        </Box>

        <Box className="flex-row items-end justify-between mt-2">
          <Box className="gap-1">
            <Box className="flex-row items-center gap-1">
              <MaterialSymbols name="memory" size={16} className="text-typography-500 dark:text-typography-400" />
              <Text className="text-typography-500 dark:text-typography-400 text-xs">4.8GB RAM</Text>
            </Box>
            <Box className="flex-row items-center gap-1">
              <MaterialSymbols name="speed" size={16} className="text-typography-500 dark:text-typography-400" />
              <Text className="text-typography-500 dark:text-typography-400 text-xs">42 t/s</Text>
            </Box>
          </Box>
          
          <Pressable 
            onPress={onSwapModel} 
            className="px-4 h-9 bg-primary-500 items-center justify-center rounded-lg shadow-lg active:scale-95 active:opacity-90 transition-all"
          >
            <Text className="text-typography-0 text-sm font-semibold">Swap Model</Text>
          </Pressable>
        </Box>
      </Box>
    </Box>
  );
};
