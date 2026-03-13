import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Alert } from 'react-native';
import { Box } from '@/components/ui/box';
import { FlashList } from '@shopify/flash-list';
import { Input, InputField } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from '../../components/ui/MaterialSymbols';
import { ActiveModelHeroCard } from '../../components/ui/ActiveModelHeroCard';
import { ModelListItem } from '../../components/ui/ModelListItem';
import { modelCatalogService, ModelMetadata } from '../../services/ModelCatalogService';
import { modelDownloadManager, DownloadProgress } from '../../services/ModelDownloadManager';
import { localStorageRegistry } from '../../services/LocalStorageRegistry';
import { useRouter } from 'expo-router';
import { typographyColors } from '../../utils/themeTokens';

export const ModelsCatalogScreen = () => {
    const [activeTab, setActiveTab] = useState<'All Models' | 'Downloaded'>('All Models');
    const router = useRouter();
    
    // Core data state
    const [availableModels, setAvailableModels] = useState<ModelMetadata[]>([]);
    const [downloadedModels, setDownloadedModels] = useState<ModelMetadata[]>(() => localStorageRegistry.getDownloadedModels());
    const [activeModelId, setActiveModelId] = useState<string | null>(() => localStorageRegistry.getActiveModelId());
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
        return localStorageRegistry.subscribe(() => {
            setDownloadedModels(localStorageRegistry.getDownloadedModels());
            setActiveModelId(localStorageRegistry.getActiveModelId());
        });
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
                localStorageRegistry.setActiveModelId(modelId);
                break;
            case 'unload':
                localStorageRegistry.setActiveModelId(null);
                break;
        }
    };

    // Calculate display models based on active tab
    const displayModels = activeTab === 'Downloaded' 
        ? downloadedModels.map(m => ({ ...m, fitsInRam: true } as ModelMetadata)) // Simplification for downloaded models
        : availableModels;

    const activeModelMeta = activeModelId
        ? displayModels.find(m => m.id === activeModelId) ?? downloadedModels.find(m => m.id === activeModelId)
        : null;

    const activeModelName = activeModelMeta?.name ?? 'Active Model';
    const activeModelFits =
        activeModelMeta && 'fitsInRam' in activeModelMeta ? (activeModelMeta.fitsInRam ?? true) : true;

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950 max-w-md w-full mx-auto border-x border-outline-200 dark:border-outline-800">
            <Box className="pt-6 px-4 bg-background-0/80 dark:bg-background-950/80 z-10">
                <Box className="flex-row items-center justify-between mb-4 mt-8">
                    <Pressable 
                        onPress={() => router.back()}
                        className="flex-row items-center -ml-1 active:opacity-70"
                    >
                        <MaterialSymbols name="chevron-left" size={28} className="text-primary-500" />
                        <Text className="text-sm font-medium text-primary-500">Back</Text>
                    </Pressable>
                    <Text className="text-lg font-bold tracking-tight text-typography-900 dark:text-typography-100">Model Catalog</Text>
                </Box>

                {/* Search Bar */}
                <Box className="flex-row w-full items-center rounded-lg bg-background-50 dark:bg-background-900/60 mb-4 h-10 px-3 border border-outline-200 dark:border-outline-800">
                    <MaterialSymbols name="search" size={20} className="text-typography-500 dark:text-typography-400" />
                    <Input className="flex-1 h-full ml-2 border-0 bg-transparent flex items-center justify-center">
                        <InputField 
                            className="text-sm text-typography-900 dark:text-typography-100 -mt-2"
                            placeholder="Search models..."
                            placeholderTextColor={typographyColors[400]}
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                        />
                    </Input>
                    {searchQuery.length > 0 && (
                        <Pressable 
                            onPress={() => setSearchQuery('')} 
                            className="active:opacity-70"
                        >
                            <MaterialSymbols name="close" size={18} className="text-typography-400" />
                        </Pressable>
                    )}
                </Box>

                {/* Tabs */}
                <Box className="flex-row gap-6 border-b border-outline-200 dark:border-primary-500/20">
                    <Pressable 
                        onPress={() => setActiveTab('All Models')}
                        className={`items-center pb-2 border-b-2 ${activeTab === 'All Models' ? 'border-primary-500' : 'border-transparent'}`}
                    >
                        <Text className={`text-sm ${activeTab === 'All Models' ? 'font-bold text-primary-500' : 'font-medium text-typography-500 dark:text-typography-400'}`}>
                            All Models
                        </Text>
                    </Pressable>
                    <Pressable 
                        onPress={() => setActiveTab('Downloaded')}
                        className={`items-center pb-2 border-b-2 ${activeTab === 'Downloaded' ? 'border-primary-500' : 'border-transparent'}`}
                    >
                        <Text className={`text-sm ${activeTab === 'Downloaded' ? 'font-bold text-primary-500' : 'font-medium text-typography-500 dark:text-typography-400'}`}>
                            Downloaded
                        </Text>
                    </Pressable>
                </Box>
            </Box>

            <Box className="flex-1 px-4 pt-4">
                {activeModelId && (
                    <Box className="mb-4">
                        <ActiveModelHeroCard
                            name={activeModelName}
                            fitsInRam={activeModelFits}
                            memoryUsedGB={4.2}
                            memoryTotalGB={8}
                            onChat={() => router.push('/(tabs)/chat' as any)}
                            onUnload={() => handleModelAction(activeModelId, 'unload')}
                        />
                    </Box>
                )}
                
                <Box className="flex-1 min-h-80">
                    {activeTab === 'All Models' && loading && availableModels.length === 0 ? (
                        <Box className="py-12 items-center">
                            <Spinner size="large" className="text-primary-500" />
                        </Box>
                    ) : (
                        <FlashList
                            data={displayModels}
                            keyExtractor={(item) => item.id}
                            showsVerticalScrollIndicator={false}
                            renderItem={({ item: model }) => {
                                const isDownloaded = localStorageRegistry.isModelDownloaded(model.id);
                                const isActive = activeModelId === model.id;
                                
                                const progress = progresses.find(p => p.modelId === model.id);
                                const isDownloading = progress?.status === 'downloading' || progress?.status === 'pending' || progress?.status === 'verifying';
                                const downloadProgress = typeof progress?.percent === 'number' ? progress.percent : 0;

                                let status: 'active' | 'downloaded' | 'available' = 'available';
                                if (isActive) status = 'active';
                                else if (isDownloaded) status = 'downloaded';

                                const sizeMB = 'sizeMB' in model ? model.sizeMB : (model.sizeBytes / 1024 / 1024);
                                
                                const imageUrl = "https://lh3.googleusercontent.com/aida-public/AB6AXuBzxg9E9wLZxtg8yHcR5e4oapN5ydJEAg2UzLt3mM7C2PZj8mdUd2aNzRS4afK2FWvySbPIkHyGk8w_QvhaV7-5LTWoTBOhQsJXQI6tmqDyS65zanPiH6JV-D9L6jx57cL05D6S4oSqcUgC5Riy-LSHUdAzfaGOSnS_3K0bFl7kcwP3a_9sOE1sChjyL4banu_i0weZ7zo7YQ8zJxwVTkbNyyRiYBVCy2Rgd7wvbybEXI0Ar_KdBiBCbnfhX5B_lpfyP_TtLsgeS2Vp";

                                return (
                                    <Box className="mb-4">
                                        <ModelListItem 
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
                                    </Box>
                                );
                            }}
                        />
                    )}
                </Box>
            </Box>
        </Box>
    );
};
