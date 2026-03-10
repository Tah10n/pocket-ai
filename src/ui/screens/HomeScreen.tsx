import React from 'react';
import { View, ScrollView, Pressable, Text } from 'react-native';
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
        <View className="flex-1 bg-background-light dark:bg-background-dark">
            <HeaderBar title="Pocket AI" showProfile={true} />
            
            <ScrollView 
                className="flex-1"
                contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
                showsVerticalScrollIndicator={false}
            >
                <ActiveModelCard onSwapModel={() => router.push('/(tabs)/models' as any)} />
                
                <View className="px-4 py-6">
                    <Pressable 
                        onPress={() => router.push('/(tabs)/chat')}
                        style={({ pressed }) => [
                          { transform: [{ scale: pressed ? 0.98 : 1 }], opacity: pressed ? 0.9 : 1 }
                        ]}
                        className="flex-row w-full items-center justify-center rounded-xl h-14 bg-primary shadow-xl shadow-primary/20 gap-3"
                    >
                        <MaterialSymbols name="add-comment" size={22} className="text-white" />
                        <Text className="text-white text-base font-bold">New Chat</Text>
                    </Pressable>
                </View>

                <View className="px-4">
                    <Text className="text-slate-900 dark:text-slate-100 text-lg font-bold leading-tight tracking-tight">Quick Actions</Text>
                </View>

                <QuickActionsGrid onCatalogPress={() => router.push('/(tabs)/models' as any)} />
                
                <RecentConversationsList />
            </ScrollView>
        </View>
    );
};
