import React, { ComponentProps } from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { FlashList, ListRenderItem } from '@shopify/flash-list';

type IconName = ComponentProps<typeof MaterialSymbols>['name'];

interface Conversation {
  id: string;
  title: string;
  model: string;
  time: string;
  icon: IconName;
}

const mockConversations: Conversation[] = [
  { id: '1', title: 'Optimize React Component performance', model: 'Llama 3 8B', time: '2 hours ago', icon: 'chat-bubble' },
  { id: '2', title: 'Python script for data analysis', model: 'Mistral 7B', time: 'Yesterday', icon: 'code' },
  { id: '3', title: 'Creative writing: Space odyssey', model: 'Gemma 2B', time: '3 days ago', icon: 'draw' },
];

export const RecentConversationsList = () => {
  const renderItem: ListRenderItem<Conversation> = ({ item: conv }) => (
    <Pressable 
      className="flex-row items-center p-4 rounded-xl bg-background-50 dark:bg-primary-500/5 border border-outline-200 dark:border-primary-500/10 transition-colors active:opacity-70"
    >
      <Box className="size-10 rounded-lg bg-background-100 dark:bg-primary-500/20 items-center justify-center shrink-0">
        <MaterialSymbols name={conv.icon} size={20} className="text-primary-500" />
      </Box>
      
      <Box className="ml-3 flex-1 overflow-hidden">
        <Text className="text-typography-900 dark:text-typography-100 font-semibold truncate" numberOfLines={1}>{conv.title}</Text>
        <Box className="flex-row items-center gap-2 mt-0.5">
          <Text className="text-typography-500 dark:text-typography-400 text-xs">{conv.model}</Text>
          <Box className="w-1 h-1 rounded-full bg-outline-400" />
          <Text className="text-typography-500 dark:text-typography-400 text-xs">{conv.time}</Text>
        </Box>
      </Box>
      
      <MaterialSymbols name="chevron-right" size={20} className="text-typography-400" />
    </Pressable>
  );

  return (
    <Box className="px-4 mt-8 pb-4">
      <Box className="flex-row items-center justify-between mb-4">
        <Text className="text-typography-900 dark:text-typography-100 text-lg font-bold leading-tight tracking-tight">Recent Conversations</Text>
        <Pressable>
          <Text className="text-primary-500 text-xs font-bold uppercase tracking-wider">See All</Text>
        </Pressable>
      </Box>

      <Box className="flex-1 min-h-80">
        <FlashList<Conversation>
          data={mockConversations}
          ItemSeparatorComponent={() => <Box className="h-3" />}
          keyExtractor={(item) => item.id}
          scrollEnabled={false}
          renderItem={renderItem}
        />
      </Box>
    </Box>
  );
};
