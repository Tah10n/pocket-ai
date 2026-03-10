import React from 'react';
import { View, Text, Pressable, ImageBackground } from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialSymbols } from './MaterialSymbols';

interface ActiveModelCardProps {
  onSwapModel?: () => void;
}

export const ActiveModelCard = ({ onSwapModel }: ActiveModelCardProps) => {
  return (
    <View className="mx-4 mt-4 rounded-xl shadow-xl bg-white dark:bg-primary/10 border border-slate-200 dark:border-primary/20 overflow-hidden">
      <ImageBackground 
        source={{ uri: "https://lh3.googleusercontent.com/aida-public/AB6AXuBgeacQzvDee5FRz4IolAFCYeRdjSi5o964zo1nH9_1RSd9jOXPsbeN7v2xGEizVFs5ap4YlxkkTvYwU7gAsmGYx5fdjy-EXVSDSplqL6g442DP_jqpWlBitLu19YImIfHJbZYQpZv3VcFmqTpeZ_4PyHInFynYgjtublbwQyS1CMUs9W381FQ7AEcDpX-74bUZcI2DZBNIMXsm5MVuPa4uPRBjhiiHrtM3aM-1xahPOz-5J7NEKxdVQg4hCDW573lexS2Kb4VbxWDV" }} 
        className="w-full aspect-video justify-end"
      >
        <BlurView intensity={20} tint="dark" className="absolute inset-0" />
        <View className="flex-row items-center gap-2 p-4 pb-3">
          <View className="w-2 h-2 rounded-full bg-green-500" />
          <Text className="text-xs font-medium text-white uppercase tracking-widest">System Ready</Text>
        </View>
      </ImageBackground>

      <View className="px-4 py-4 gap-1">
        <Text className="text-slate-500 dark:text-slate-400 text-sm font-medium">Active Model</Text>
        <View className="flex-row items-baseline gap-2">
            <Text className="text-slate-900 dark:text-slate-100 text-xl font-bold tracking-tight">Llama 3 8B</Text>
            <View className="px-2 py-0.5 bg-primary/20 rounded-full">
                <Text className="text-xs font-normal text-primary">Instruct</Text>
            </View>
        </View>

        <View className="flex-row items-end justify-between mt-2">
          <View className="gap-1">
            <View className="flex-row items-center gap-1">
              <MaterialSymbols name="memory" size={16} className="text-slate-500 dark:text-slate-400" />
              <Text className="text-slate-500 dark:text-slate-400 text-xs">4.8GB RAM</Text>
            </View>
            <View className="flex-row items-center gap-1">
              <MaterialSymbols name="speed" size={16} className="text-slate-500 dark:text-slate-400" />
              <Text className="text-slate-500 dark:text-slate-400 text-xs">42 t/s</Text>
            </View>
          </View>
          
          <Pressable 
            onPress={onSwapModel} 
            style={({ pressed }) => [
              { transform: [{ scale: pressed ? 0.98 : 1 }], opacity: pressed ? 0.9 : 1 }
            ]}
            className="px-4 h-9 bg-primary items-center justify-center rounded-lg shadow-lg"
          >
            <Text className="text-white text-[13px] font-semibold">Swap Model</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
};
