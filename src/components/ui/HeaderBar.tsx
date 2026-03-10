import React from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialSymbols } from './MaterialSymbols';

interface HeaderBarProps {
  title: string;
  onBack?: () => void;
  showProfile?: boolean;
}

export const HeaderBar = ({ title, onBack, showProfile = false }: HeaderBarProps) => {
  return (
    <View className="sticky top-0 z-10 w-full overflow-hidden border-b border-slate-200 dark:border-slate-800">
      <BlurView intensity={80} tint="default" className="flex-row items-center justify-between px-4 py-4 bg-background-light/80 dark:bg-background-dark/80">
        <View className="flex-row items-center gap-3">
            {onBack ? (
                <TouchableOpacity onPress={onBack} activeOpacity={0.7}>
                    <MaterialSymbols name="arrow_back_ios" size={24} className="text-primary" />
                </TouchableOpacity>
            ) : (
                <View className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                    <MaterialSymbols name="terminal" size={24} className="text-primary" />
                </View>
            )}
            
            <Text className={`text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 ${!onBack ? 'flex-1 text-center' : ''}`}>
                {title}
            </Text>
        </View>

        <View className="flex-row items-center gap-4">
            <TouchableOpacity activeOpacity={0.7} className="flex h-10 w-10 items-center justify-center rounded-lg bg-transparent hover:bg-primary/10 transition-colors">
                <MaterialSymbols name="search" size={24} className="text-slate-500 dark:text-slate-400" />
            </TouchableOpacity>
            {showProfile && (
                <View className="w-8 h-8 rounded-full bg-primary/20 items-center justify-center overflow-hidden border border-primary/30">
                    <Image source={{ uri: "https://lh3.googleusercontent.com/aida-public/AB6AXuCqNWAZMZvtAQjBF9FQ-Ymu-tSmuLeRqqO16vZ41k3qnCZPlJZqKWaP1u4vCa4uM7MoFx4hwH84T6aSbztQ7kelrlnuqttZlqDr7ldshimP6SG0HqhlsHDhrB1WXbixUYFbs_8g3lEsddq3PrhcVEB5PYPEyFfAIuQJsHdTQZmquJwhGl1jtML0VjHph_H2ZOOawzZvR0J5lfOfs87hUpid8PY0Aa_fafpFYooVluOzKdEBNW1zox2_6HhqhHPt88ZG_kyV9wNzjIh-"}} className="w-full h-full object-cover" />
                </View>
            )}
        </View>
      </BlurView>
    </View>
  );
};
