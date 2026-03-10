import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { MaterialSymbols } from './MaterialSymbols';

const mockConversations = [
  { id: '1', title: 'Optimize React Component performance', model: 'Llama 3 8B', time: '2 hours ago', icon: 'chat_bubble' },
  { id: '2', title: 'Python script for data analysis', model: 'Mistral 7B', time: 'Yesterday', icon: 'code' },
  { id: '3', title: 'Creative writing: Space odyssey', model: 'Gemma 2B', time: '3 days ago', icon: 'draw' },
];

export const RecentConversationsList = () => {
  return (
    <View className="px-4 mt-8 pb-4">
      <View className="flex-row items-center justify-between mb-4">
        <Text className="text-slate-900 dark:text-slate-100 text-lg font-bold leading-tight tracking-tight">Recent Conversations</Text>
        <TouchableOpacity>
          <Text className="text-primary text-xs font-bold uppercase tracking-wider">See All</Text>
        </TouchableOpacity>
      </View>

      <View className="gap-3">
        {mockConversations.map((conv) => (
          <TouchableOpacity 
            key={conv.id} 
            activeOpacity={0.7}
            className="flex-row items-center p-4 rounded-xl bg-white dark:bg-primary/5 border border-slate-200 dark:border-primary/10 transition-colors"
          >
            <View className="size-10 rounded-lg bg-slate-100 dark:bg-primary/20 items-center justify-center shrink-0">
              <MaterialSymbols name={conv.icon} size={20} className="text-primary" />
            </View>
            
            <View className="ml-3 flex-1 overflow-hidden">
              <Text className="text-slate-900 dark:text-slate-100 font-semibold truncate" numberOfLines={1}>{conv.title}</Text>
              <View className="flex-row items-center gap-2 mt-0.5">
                <Text className="text-slate-500 dark:text-slate-400 text-xs">{conv.model}</Text>
                <View className="w-1 h-1 rounded-full bg-slate-400" />
                <Text className="text-slate-500 dark:text-slate-400 text-xs">{conv.time}</Text>
              </View>
            </View>
            
            <MaterialSymbols name="chevron_right" size={20} className="text-slate-400" />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
};
