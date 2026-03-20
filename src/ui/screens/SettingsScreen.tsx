import React from 'react';
import { Alert } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { ScrollView } from '@/components/ui/scroll-view';
import { Pressable } from '@/components/ui/pressable';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { useDeviceMetrics } from '../../hooks/useDeviceMetrics';
import { useTheme } from '../../providers/ThemeProvider';
import { llmEngineService } from '../../services/LLMEngineService';


export const SettingsScreen = () => {
    const { mode, resolvedMode, setTheme } = useTheme();
    const metrics = useDeviceMetrics();

    const unloadActiveModel = async () => {
        await llmEngineService.unload();
    };

    const handleLanguagePress = () => {
        Alert.alert('Language', 'Language selection will be available in a future update.');
    };

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950 max-w-2xl w-full mx-auto pb-24">
            <HeaderBar 
                title="Settings" 
                showProfile={true} 
            />

            <ScrollView className="flex-1 mt-6 px-4" showsVerticalScrollIndicator={false}>
                {/* Appearance Section */}
                <Text className="text-xs font-semibold uppercase tracking-wider text-typography-500 dark:text-typography-400 ml-4 mb-2">
                    Appearance
                </Text>
                
                <Box className="bg-background-50 dark:bg-background-900/50 rounded-xl overflow-hidden border border-outline-200 dark:border-outline-800 mb-8">
                    {/* Theme Mode Segment */}
                    <Box className="flex-row px-4 py-4 items-center justify-between border-b border-outline-200 dark:border-outline-800">
                        <Box className="flex-row items-center gap-3">
                            <Box className="bg-info-500/20 p-2 rounded-lg">
                                <MaterialSymbols name="palette" size={20} className="text-info-500" />
                            </Box>
                            <Text className="font-medium text-typography-900 dark:text-typography-100">Theme Mode</Text>
                        </Box>
                        
                        <Box className="flex-row h-9 w-56 items-center justify-between rounded-lg bg-background-100 dark:bg-background-800 p-1">
                            <Pressable 
                                onPress={() => setTheme('light')}
                                className={`flex-1 h-full items-center justify-center rounded-md px-2 ${mode === 'light' ? 'bg-background-0 dark:bg-background-700 shadow-sm' : 'bg-transparent'}`}
                            >
                                <Text className={`text-xs font-semibold ${mode === 'light' ? 'text-primary-600 dark:text-typography-0' : 'text-typography-500 dark:text-typography-400'}`}>Light</Text>
                            </Pressable>
                            <Pressable 
                                onPress={() => setTheme('system')}
                                className={`flex-1 h-full items-center justify-center rounded-md px-2 ${mode === 'system' ? 'bg-background-0 dark:bg-background-700 shadow-sm' : 'bg-transparent'}`}
                            >
                                <Text className={`text-xs font-semibold ${mode === 'system' ? 'text-primary-600 dark:text-typography-0' : 'text-typography-500 dark:text-typography-400'}`}>System</Text>
                            </Pressable>
                            <Pressable 
                                onPress={() => setTheme('dark')}
                                className={`flex-1 h-full items-center justify-center rounded-md px-2 ${mode === 'dark' ? 'bg-background-0 dark:bg-background-700 shadow-sm' : 'bg-transparent'}`}
                            >
                                <Text className={`text-xs font-semibold ${mode === 'dark' ? 'text-primary-600 dark:text-typography-0' : 'text-typography-500 dark:text-typography-400'}`}>Dark</Text>
                            </Pressable>
                        </Box>
                    </Box>
                    
                    {/* Language Segment */}
                    <Pressable 
                        onPress={handleLanguagePress}
                        className="flex-row px-4 py-4 items-center justify-between active:opacity-70"
                    >
                        <Box className="flex-row items-center gap-3">
                            <Box className="bg-primary-500/20 p-2 rounded-lg">
                                <MaterialSymbols name="language" size={20} className="text-primary-600" />
                            </Box>
                            <Text className="font-medium text-typography-900 dark:text-typography-100">Language</Text>
                        </Box>
                        <Box className="flex-row items-center gap-1">
                            <Text className="text-sm text-typography-500 dark:text-typography-400">English (US)</Text>
                            <MaterialSymbols name="chevron-right" size={20} className="text-typography-400" />
                        </Box>
                    </Pressable>
                </Box>

                {/* Performance & Resources Section */}
                <Text className="text-xs font-semibold uppercase tracking-wider text-typography-500 dark:text-typography-400 ml-4 mb-2">
                    Performance & Resources
                </Text>
                
                <Box className="bg-background-50 dark:bg-background-900/50 rounded-xl overflow-hidden border border-outline-200 dark:border-outline-800 mb-8">
                    {/* Storage Info */}
                    <Box className="p-4 border-b border-outline-200 dark:border-outline-800">
                        <Box className="flex-row justify-between items-center mb-3">
                            <Box className="flex-row items-center gap-3">
                                <Box className="bg-warning-500/20 p-2 rounded-lg">
                                    <MaterialSymbols name="storage" size={20} className="text-warning-500" />
                                </Box>
                                <Text className="font-medium text-typography-900 dark:text-typography-100">Device Storage</Text>
                            </Box>
                            <Text className="text-xs font-bold text-typography-500 italic">{metrics?.storage.usedPercentage || 0}% Used</Text>
                        </Box>
                        
                        {/* Storage Bar */}
                        <Box className="w-full bg-background-200 dark:bg-background-800 h-2.5 rounded-full overflow-hidden flex-row">
                            <Box className="bg-primary-500 h-full" style={{ width: `${(metrics?.storage.appsGB || 0) / (metrics?.storage.totalGB || 1) * 100}%` }} />
                            <Box className="bg-info-400 h-full" style={{ width: `${(metrics?.storage.systemGB || 0) / (metrics?.storage.totalGB || 1) * 100}%` }} />
                            <Box className="bg-background-400 h-full" style={{ width: `${(metrics?.storage.otherGB || 0) / (metrics?.storage.totalGB || 1) * 100}%` }} />
                        </Box>
                        
                        {/* Storage Legend */}
                        <Box className="mt-3 flex-row gap-4">
                            <Box className="flex-row items-center gap-1">
                                <Box className="w-2 h-2 rounded-full bg-primary-500" />
                                <Text className="text-xs text-typography-500 dark:text-typography-400 uppercase font-bold">Apps ({metrics?.storage.appsGB || 0}GB)</Text>
                            </Box>
                            <Box className="flex-row items-center gap-1">
                                <Box className="w-2 h-2 rounded-full bg-info-400" />
                                <Text className="text-xs text-typography-500 dark:text-typography-400 uppercase font-bold">System ({metrics?.storage.systemGB || 0}GB)</Text>
                            </Box>
                            <Box className="flex-row items-center gap-1">
                                <Box className="w-2 h-2 rounded-full bg-background-400" />
                                <Text className="text-xs text-typography-500 dark:text-typography-400 uppercase font-bold">Other ({metrics?.storage.otherGB || 0}GB)</Text>
                            </Box>
                        </Box>
                    </Box>


                    {/* RAM Usage */}
                    <Box className="p-4">
                        <Box className="flex-row justify-between items-center mb-3">
                            <Box className="flex-row items-center gap-3">
                                <Box className="bg-success-500/20 p-2 rounded-lg">
                                    <MaterialSymbols name="memory" size={20} className="text-success-500" />
                                </Box>
                                <Text className="font-medium text-typography-900 dark:text-typography-100">Memory (RAM)</Text>
                            </Box>
                            <Text className="text-xs font-bold text-success-500">Optimized</Text>
                        </Box>
                        
                        <Box className="flex-row items-center justify-between bg-background-100 dark:bg-background-800/50 p-3 rounded-lg">
                            <Box className="items-center flex-1 border-r border-outline-200 dark:border-outline-700">
                                <Text className="text-xs text-typography-500 uppercase font-bold">Total</Text>
                                <Text className="text-lg font-bold text-typography-900 dark:text-typography-100">{metrics?.ram.totalGB ?? 0} GB</Text>
                            </Box>
                            <Box className="items-center flex-1 border-r border-outline-200 dark:border-outline-700">
                                <Text className="text-xs text-typography-500 uppercase font-bold">Available</Text>
                                <Text className="text-lg font-bold text-primary-500">{(metrics?.ram.availableGB ?? 0).toFixed(2)} GB</Text>
                            </Box>
                            <Box className="items-center flex-1">
                                <Text className="text-xs text-typography-500 uppercase font-bold">Cached</Text>
                                <Text className="text-lg font-bold text-typography-400 dark:text-typography-500">{(metrics?.ram.cachedGB ?? 0).toFixed(2)} GB</Text>
                            </Box>
                        </Box>
                        
                        <Pressable 
                            onPress={unloadActiveModel}
                            className="mt-4 w-full py-2 bg-warning-500/10 items-center justify-center rounded-lg active:opacity-70"
                        >
                            <Text className="text-warning-600 text-sm font-semibold">Unload Active Model</Text>
                        </Pressable>
                    </Box>
                </Box>

                {/* Privacy & Security Section */}
                <Text className="text-xs font-semibold uppercase tracking-wider text-typography-500 dark:text-typography-400 ml-4 mb-2">
                    Privacy & Security
                </Text>
                
                <Box className="bg-background-50 dark:bg-background-900/50 rounded-xl overflow-hidden border border-outline-200 dark:border-outline-800 mb-8">
                    <Pressable 
                        className="flex-row px-4 py-4 items-center justify-between active:opacity-70"
                    >
                        <Box className="flex-row items-center gap-3">
                            <Box className="bg-info-400/20 p-2 rounded-lg">
                                <MaterialSymbols name="visibility-off" size={20} className="text-info-400" />
                            </Box>
                            <Text className="font-medium text-typography-900 dark:text-typography-100">Privacy Report</Text>
                        </Box>
                        <MaterialSymbols name="chevron-right" size={20} className="text-typography-400" />
                    </Pressable>
                </Box>
            </ScrollView>
        </Box>
    );
};
