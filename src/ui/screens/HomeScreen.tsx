import React from 'react';
import { View, ScrollView, TouchableOpacity, Text } from 'react-native';
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
                    <TouchableOpacity 
                        activeOpacity={0.8}
                        onPress={() => router.push('/(tabs)/chat')}
                        className="flex-row w-full items-center justify-center rounded-xl h-14 bg-primary shadow-xl shadow-primary/20 transition-all gap-3"
                    >
                        <MaterialSymbols name="add_comment" size={24} className="text-white" />
                        <Text className="text-white text-base font-bold">New Chat</Text>
                    </TouchableOpacity>
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
