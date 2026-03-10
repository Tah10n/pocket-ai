import React from 'react';
import { View, ScrollView, Text, TouchableOpacity } from 'react-native';
import { HeaderBar } from '../../components/ui/HeaderBar';
import { MaterialSymbols } from '../../components/ui/MaterialSymbols';
import { useDeviceMetrics } from '../../../src/hooks/useDeviceMetrics';
import { useSettingsStore } from '../../../src/store/settingsStore';


export const SettingsScreen = () => {
    const { theme, setTheme } = useSettingsStore();
    const metrics = useDeviceMetrics();

    return (
        <View className={`flex-1 ${theme === 'Dark' ? 'bg-background-dark' : 'bg-background-light'} max-w-2xl w-full mx-auto pb-24`}>
            <HeaderBar 
                title="Settings" 
                onBack={() => {}} 
                showProfile={true} 
            />

            <ScrollView className="flex-1 mt-6 px-4" showsVerticalScrollIndicator={false}>
                {/* Appearance Section */}
                <Text className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 ml-4 mb-2">
                    Appearance
                </Text>
                
                <View className="bg-white dark:bg-slate-900/50 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 mb-8">
                    {/* Theme Mode Segment */}
                    <View className="flex-row px-4 py-4 items-center justify-between border-b border-slate-200 dark:border-slate-800">
                        <View className="flex-row items-center gap-3">
                            <View className="bg-blue-500/20 p-2 rounded-lg">
                                <MaterialSymbols name="palette" size={20} className="text-blue-500" />
                            </View>
                            <Text className="font-medium text-slate-900 dark:text-slate-100">Theme Mode</Text>
                        </View>
                        
                        <View className="flex-row h-9 w-40 items-center justify-between rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
                            <TouchableOpacity 
                                onPress={() => setTheme('Light')}
                                className={`flex-1 h-full items-center justify-center rounded-md px-2 ${theme === 'Light' ? 'bg-white dark:bg-slate-700 shadow-sm' : 'bg-transparent'}`}
                            >
                                <Text className={`text-xs font-semibold ${theme === 'Light' ? 'text-primary dark:text-white' : 'text-slate-500 dark:text-slate-400'}`}>Light</Text>
                            </TouchableOpacity>
                            <TouchableOpacity 
                                onPress={() => setTheme('Dark')}
                                className={`flex-1 h-full items-center justify-center rounded-md px-2 ${theme === 'Dark' ? 'bg-white dark:bg-slate-700 shadow-sm' : 'bg-transparent'}`}
                            >
                                <Text className={`text-xs font-semibold ${theme === 'Dark' ? 'text-primary dark:text-white' : 'text-slate-500 dark:text-slate-400'}`}>Dark</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                    
                    {/* Language Segment */}
                    <TouchableOpacity activeOpacity={0.7} className="flex-row px-4 py-4 items-center justify-between">
                        <View className="flex-row items-center gap-3">
                            <View className="bg-indigo-500/20 p-2 rounded-lg">
                                <MaterialSymbols name="language" size={20} className="text-indigo-500" />
                            </View>
                            <Text className="font-medium text-slate-900 dark:text-slate-100">Language</Text>
                        </View>
                        <View className="flex-row items-center gap-1">
                            <Text className="text-sm text-slate-500 dark:text-slate-400">English (US)</Text>
                            <MaterialSymbols name="chevron_right" size={20} className="text-slate-400" />
                        </View>
                    </TouchableOpacity>
                </View>

                {/* Performance & Resources Section */}
                <Text className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 ml-4 mb-2">
                    Performance & Resources
                </Text>
                
                <View className="bg-white dark:bg-slate-900/50 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 mb-8">
                    {/* Storage Info */}
                    <View className="p-4 border-b border-slate-200 dark:border-slate-800">
                        <View className="flex-row justify-between items-center mb-3">
                            <View className="flex-row items-center gap-3">
                                <View className="bg-amber-500/20 p-2 rounded-lg">
                                    <MaterialSymbols name="database" size={20} className="text-amber-500" />
                                </View>
                                <Text className="font-medium text-slate-900 dark:text-slate-100">Device Storage</Text>
                            </View>
                            <Text className="text-xs font-bold text-slate-500 italic">{metrics?.storage.usedPercentage || 0}% Used</Text>
                        </View>
                        
                        {/* Storage Bar */}
                        <View className="w-full bg-slate-200 dark:bg-slate-800 h-2.5 rounded-full overflow-hidden flex-row">
                            <View className="bg-primary h-full" style={{ width: `${(metrics?.storage.appsGB || 0) / (metrics?.storage.totalGB || 1) * 100}%` }} />
                            <View className="bg-indigo-400 h-full" style={{ width: `${(metrics?.storage.systemGB || 0) / (metrics?.storage.totalGB || 1) * 100}%` }} />
                            <View className="bg-slate-400 h-full" style={{ width: `${(metrics?.storage.otherGB || 0) / (metrics?.storage.totalGB || 1) * 100}%` }} />
                        </View>
                        
                        {/* Storage Legend */}
                        <View className="mt-3 flex-row gap-4">
                            <View className="flex-row items-center gap-1">
                                <View className="w-2 h-2 rounded-full bg-primary" />
                                <Text className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-bold tracking-tighter">Apps ({metrics?.storage.appsGB || 0}GB)</Text>
                            </View>
                            <View className="flex-row items-center gap-1">
                                <View className="w-2 h-2 rounded-full bg-indigo-400" />
                                <Text className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-bold tracking-tighter">System ({metrics?.storage.systemGB || 0}GB)</Text>
                            </View>
                            <View className="flex-row items-center gap-1">
                                <View className="w-2 h-2 rounded-full bg-slate-400" />
                                <Text className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-bold tracking-tighter">Other ({metrics?.storage.otherGB || 0}GB)</Text>
                            </View>
                        </View>
                    </View>

                    {/* RAM Usage */}
                    <View className="p-4">
                        <View className="flex-row justify-between items-center mb-3">
                            <View className="flex-row items-center gap-3">
                                <View className="bg-emerald-500/20 p-2 rounded-lg">
                                    <MaterialSymbols name="memory" size={20} className="text-emerald-500" />
                                </View>
                                <Text className="font-medium text-slate-900 dark:text-slate-100">Memory (RAM)</Text>
                            </View>
                            <Text className="text-xs font-bold text-emerald-500">Optimized</Text>
                        </View>
                        
                        <View className="flex-row items-center justify-between bg-slate-100 dark:bg-slate-800/50 p-3 rounded-lg">
                            <View className="items-center flex-1 border-r border-slate-200 dark:border-slate-700">
                                <Text className="text-[10px] text-slate-500 uppercase font-bold">Total</Text>
                                <Text className="text-lg font-bold text-slate-900 dark:text-slate-100">{metrics?.ram.totalGB || 0} GB</Text>
                            </View>
                            <View className="items-center flex-1 border-r border-slate-200 dark:border-slate-700">
                                <Text className="text-[10px] text-slate-500 uppercase font-bold">Available</Text>
                                <Text className="text-lg font-bold text-primary">{metrics?.ram.availableGB || 0} GB</Text>
                            </View>
                            <View className="items-center flex-1">
                                <Text className="text-[10px] text-slate-500 uppercase font-bold">Cached</Text>
                                <Text className="text-lg font-bold text-slate-400 dark:text-slate-500">{metrics?.ram.cachedGB || 0} GB</Text>
                            </View>
                        </View>
                        
                        <TouchableOpacity activeOpacity={0.7} className="mt-4 w-full py-2 bg-primary/10 items-center justify-center rounded-lg transition-colors">
                            <Text className="text-primary text-sm font-semibold">Clear Active Cache</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Privacy & Security Section */}
                <Text className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 ml-4 mb-2">
                    Privacy & Security
                </Text>
                
                <View className="bg-white dark:bg-slate-900/50 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 mb-8">
                    <TouchableOpacity activeOpacity={0.7} className="flex-row px-4 py-4 items-center justify-between">
                        <View className="flex-row items-center gap-3">
                            <View className="bg-blue-400/20 p-2 rounded-lg">
                                <MaterialSymbols name="visibility_off" size={20} className="text-blue-400" />
                            </View>
                            <Text className="font-medium text-slate-900 dark:text-slate-100">Privacy Report</Text>
                        </View>
                        <MaterialSymbols name="chevron_right" size={20} className="text-slate-400" />
                    </TouchableOpacity>
                </View>
            </ScrollView>
        </View>
    );
};
