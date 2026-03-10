import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, ScrollView, TextInput, Pressable, Text, ActivityIndicator, Alert } from 'react-native';
import { MaterialSymbols } from '../../components/ui/MaterialSymbols';
import { ActiveModelCard } from '../../components/ui/ActiveModelCard';
import { ModelListItem } from '../../components/ui/ModelListItem';
import { useModelsStore } from '../../store/modelsStore';
import { modelCatalogService, ModelMetadata } from '../../services/ModelCatalogService';
import { modelDownloadManager, DownloadProgress } from '../../services/ModelDownloadManager';
import { localStorageRegistry } from '../../services/LocalStorageRegistry';

export const ModelsCatalogScreen = () => {
    const [activeTab, setActiveTab] = useState<'All Models' | 'Downloaded'>('All Models');
    const { setActiveModel, activeModelId, downloadedModels } = useModelsStore();
    
    // Core data state
    const [availableModels, setAvailableModels] = useState<ModelMetadata[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [progresses, setProgresses] = useState<DownloadProgress[]>([]);

    const requestIdRef = useRef(0);

    const loadModels = useCallback(async (q: string) => {
        const requestId = ++requestIdRef.current;
        try {
            setLoading(true);
            const trimmed = q.trim();
            const results = await modelCatalogService.getAvailableModels(trimmed.length > 0 ? trimmed : undefined);
            if (requestId !== requestIdRef.current) return;
            setAvailableModels(results);
        } catch (e) {
            if (requestId !== requestIdRef.current) return;
            setAvailableModels([]);
            console.warn('[ModelCatalog] loadModels failed', e);
        } finally {
            if (requestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        const unsub = modelDownloadManager.subscribe((p) => setProgresses(p));
        return unsub;
    }, []);

    useEffect(() => {
        if (activeTab === 'All Models') {
            const delayMs = searchQuery.trim().length > 0 ? 400 : 0;
            const handle = setTimeout(() => loadModels(searchQuery), delayMs);
            return () => clearTimeout(handle);
        }
    }, [searchQuery, loadModels, activeTab]);

    const handleModelAction = async (modelId: string, action: 'download' | 'load' | 'unload' | 'cancel') => {
        const modelMeta = availableModels.find(m => m.id === modelId) as ModelMetadata;

        switch (action) {
            case 'download':
                if (!modelMeta) return;
                try {
                    await modelDownloadManager.startDownload(modelMeta);
                } catch (e: any) {
                    if (e.message === 'CELLULAR_DATA_WARNING') {
                        Alert.alert('Warning', 'You are on a cellular network. Downloading large models is not recommended.');
                    }
                }
                break;
            case 'cancel':
                modelDownloadManager.cancelDownload(modelId);
                break;
            case 'load':
                setActiveModel(modelId);
                break;
            case 'unload':
                setActiveModel(null);
                break;
        }
    };

    // Calculate display models based on active tab
    const displayModels = activeTab === 'Downloaded' 
        ? downloadedModels.map(m => ({ ...m, fitsInRam: true })) // Simplification for downloaded models
        : availableModels;

    return (
        <View className="flex-1 bg-background-light dark:bg-background-dark max-w-md w-full mx-auto border-x border-slate-200 dark:border-slate-800">
            <View className="pt-6 px-4 bg-background-light/80 dark:bg-background-dark/80 z-10">
                <View className="flex-row items-center justify-between mb-4 mt-8">
                    <Pressable 
                        style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
                        className="flex-row items-center -ml-1"
                    >
                        <MaterialSymbols name="chevron-left" size={28} className="text-primary" />
                        <Text className="text-sm font-medium text-primary">Back</Text>
                    </Pressable>
                    <Text className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">Model Catalog</Text>
                </View>

                {/* Search Bar */}
                <View className="flex-row w-full items-center rounded-lg bg-slate-200/50 dark:bg-primary/10 overflow-hidden mb-4 h-10 px-3">
                    <MaterialSymbols name="search" size={20} className="text-slate-500 dark:text-primary/70" />
                    <TextInput 
                        className="flex-1 h-full ml-2 text-sm text-slate-900 dark:text-slate-100"
                        placeholder="Search models..."
                        placeholderTextColor="#94a3b8"
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                    />
                    {searchQuery.length > 0 && (
                        <Pressable 
                            onPress={() => setSearchQuery('')} 
                            style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
                        >
                            <MaterialSymbols name="close" size={18} className="text-slate-400" />
                        </Pressable>
                    )}
                </View>

                {/* Tabs */}
                <View className="flex-row gap-6 border-b border-slate-200 dark:border-primary/20">
                    <Pressable 
                        onPress={() => setActiveTab('All Models')}
                        className={`items-center pb-2 border-b-2 ${activeTab === 'All Models' ? 'border-primary' : 'border-transparent'}`}
                    >
                        <Text className={`text-sm ${activeTab === 'All Models' ? 'font-bold text-primary' : 'font-medium text-slate-500 dark:text-slate-400'}`}>
                            All Models
                        </Text>
                    </Pressable>
                    <Pressable 
                        onPress={() => setActiveTab('Downloaded')}
                        className={`items-center pb-2 border-b-2 ${activeTab === 'Downloaded' ? 'border-primary' : 'border-transparent'}`}
                    >
                        <Text className={`text-sm ${activeTab === 'Downloaded' ? 'font-bold text-primary' : 'font-medium text-slate-500 dark:text-slate-400'}`}>
                            Downloaded
                        </Text>
                    </Pressable>
                </View>
            </View>

            <ScrollView className="flex-1 p-4" showsVerticalScrollIndicator={false}>
                {activeModelId && <ActiveModelCard />}
                
                <View className="mt-4">
                    {activeTab === 'All Models' && loading && availableModels.length === 0 ? (
                        <View className="py-12 items-center">
                            <ActivityIndicator size="large" color="#3b82f6" />
                        </View>
                    ) : (
                        displayModels.map(model => {
                            const isDownloaded = localStorageRegistry.isModelDownloaded(model.id);
                            const isActive = activeModelId === model.id;
                            
                            const progress = progresses.find(p => p.modelId === model.id);
                            const isDownloading = progress?.status === 'downloading' || progress?.status === 'pending' || progress?.status === 'verifying';
                            const downloadProgress = typeof progress?.percent === 'number' ? progress.percent : 0;

                            let status: 'active' | 'downloaded' | 'available' = 'available';
                            if (isActive) status = 'active';
                            else if (isDownloaded) status = 'downloaded';

                            const sizeMB = 'sizeMB' in model ? model.sizeMB : (model.sizeBytes / 1024 / 1024);
                            
                            // Using generic images since HF doesn't provide them easily, unless we have it in store.
                            const imageUrl = "https://lh3.googleusercontent.com/aida-public/AB6AXuBzxg9E9wLZxtg8yHcR5e4oapN5ydJEAg2UzLt3mM7C2PZj8mdUd2aNzRS4afK2FWvySbPIkHyGk8w_QvhaV7-5LTWoTBOhQsJXQI6tmqDyS65zanPiH6JV-D9L6jx57cL05D6S4oSqcUgC5Riy-LSHUdAzfaGOSgS_3K0bFl7kcwP3a_9sOE1sChjyL4banu_i0weZ7zo7YQ8zJxwVTkbNyyRiYBVCy2Rgd7wvbybEXI0Ar_KdBiBCbnfhX5B_lpfyP_TtLsgeS2Vp";

                            return (
                                <ModelListItem 
                                    key={model.id} 
                                    id={model.id}
                                    name={model.name}
                                    sizeMB={sizeMB as number}
                                    fitsInRam={('fitsInRam' in model) ? (model as any).fitsInRam : true}
                                    status={status}
                                    isDownloading={isDownloading}
                                    downloadProgress={downloadProgress}
                                    imageUrl={imageUrl}
                                    onAction={(action) => handleModelAction(model.id, action)}
                                />
                            );
                        })
                    )}
                </View>
            </ScrollView>
        </View>
    );
};
