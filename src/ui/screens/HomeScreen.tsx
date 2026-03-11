import React from 'react';
import { Box } from '@/components/ui/box';
import { ScrollView } from '@/components/ui/scroll-view';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useRouter } from 'expo-router';
import { HeaderBar } from '../../components/ui/HeaderBar';
import { ActiveModelCard } from '../../components/ui/ActiveModelCard';
import { QuickActionsGrid } from '../../components/ui/QuickActionsGrid';
import { RecentConversationsList } from '../../components/ui/RecentConversationsList';
import { MaterialSymbols } from '../../components/ui/MaterialSymbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const HomeScreen = () => {
    const insets = useSafeAreaInsets();
    const router = useRouter();

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950">
            <HeaderBar title="Pocket AI" showProfile={true} />
            
            <ScrollView 
                className="flex-1"
                contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
                showsVerticalScrollIndicator={false}
            >
                <ActiveModelCard onSwapModel={() => router.push('/(tabs)/models' as any)} />
                
                <Box className="px-4 py-6">
                    <Pressable 
                        onPress={() => router.push('/(tabs)/chat')}
                        className="flex-row w-full items-center justify-center rounded-xl h-14 bg-primary-500 shadow-xl shadow-primary-500/20 gap-3 active:scale-95 active:opacity-90 transition-all"
                    >
                        <MaterialSymbols name="add-comment" size={22} className="text-typography-0" />
                        <Text className="text-typography-0 text-base font-bold">New Chat</Text>
                    </Pressable>
                </Box>

                <Box className="px-4">
                    <Text className="text-typography-900 dark:text-typography-100 text-lg font-bold leading-tight tracking-tight">Quick Actions</Text>
                </Box>

                <QuickActionsGrid onCatalogPress={() => router.push('/(tabs)/models' as any)} />
                
                <RecentConversationsList />
            </ScrollView>
        </Box>
    );
};
