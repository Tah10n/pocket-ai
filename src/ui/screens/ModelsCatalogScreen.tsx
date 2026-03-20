import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Alert } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { SearchHeader } from '@/components/ui/SearchHeader';
import { ModelCard } from '@/components/ui/ModelCard';
import { modelCatalogService } from '../../services/ModelCatalogService';
import { registry } from '../../services/LocalStorageRegistry';
import { useModelDownload } from '../../hooks/useModelDownload';
import { useLLMEngine } from '../../hooks/useLLMEngine';
import { ModelMetadata, LifecycleStatus, EngineStatus } from '../../types/models';
import { useRouter } from 'expo-router';
import { hardwareListenerService } from '../../services/HardwareListenerService';

export const ModelsCatalogScreen = () => {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'All Models' | 'Downloaded'>('All Models');
  const [searchQuery, setSearchQuery] = useState('');
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [loading, setLoading] = useState(false);

  const { startDownload, cancelDownload, queue } = useModelDownload();
  const { loadModel, unloadModel, state: engineState } = useLLMEngine();

  const fetchModels = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const results = await modelCatalogService.searchModels(query);
      setModels(results);
    } catch (e) {
      console.error('[ModelsCatalogScreen] Failed to fetch models', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'All Models') {
      const timer = setTimeout(() => fetchModels(searchQuery), 500);
      return () => clearTimeout(timer);
    } else {
      modelCatalogService.getLocalModels().then(setModels);
    }
  }, [searchQuery, activeTab, fetchModels]); 

  // Merge active queue state with fetched models for display
  const displayModels = useMemo(() => {
    return models.map(m => {
      let finalModel = { ...m };

      // Get latest local status from registry
      const localModel = registry.getModel(m.id);
      if (localModel) {
        finalModel = { ...finalModel, ...localModel };
      }

      // Override status based on engine state
      if (engineState.activeModelId === finalModel.id) {
        finalModel.lifecycleStatus = LifecycleStatus.ACTIVE;
      } else if (finalModel.lifecycleStatus === LifecycleStatus.ACTIVE) {
        finalModel.lifecycleStatus = LifecycleStatus.DOWNLOADED;
      }

      // Merge queue state (overrides everything if actively downloading)
      const queuedItem = queue.find(q => q.id === finalModel.id);
      if (queuedItem) {
        finalModel = { ...finalModel, ...queuedItem };
      }

      return finalModel;
    });
  }, [models, queue, engineState.activeModelId]);

  const handleDownload = useCallback((model: ModelMetadata) => {
    const status = hardwareListenerService.getCurrentStatus();
    if (status.networkType === 'cellular') {
      Alert.alert(
        'Cellular Data Warning',
        'You are on a cellular network. Large downloads may incur costs. Proceed?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Download Anyway', onPress: () => startDownload(model) }
        ]
      );
    } else {
      startDownload(model);
    }
  }, [startDownload]);

  const handleLoad = useCallback(async (modelId: string) => {
    const model = models.find(m => m.id === modelId);
    if (model && model.fitsInRam === false) {
      Alert.alert(
        'Memory Warning',
        'This model may exceed your device RAM and cause crashes. Load anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Load Anyway', onPress: () => loadModel(modelId) }
        ]
      );
    } else {
      await loadModel(modelId);
    }
  }, [models, loadModel]);

  const handleDelete = useCallback(async (modelId: string) => {
    Alert.alert(
      'Delete Model',
      'Are you sure you want to delete this model from your device?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          await registry.removeModel(modelId);
          if (activeTab === 'All Models') {
            fetchModels(searchQuery);
          } else {
            modelCatalogService.getLocalModels().then(setModels);
          }
        }}
      ]
    );
  }, [activeTab, fetchModels, searchQuery]);

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <SearchHeader 
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onBack={() => router.back()}
      />

      <Box className="flex-1 px-4 pt-4">
        {loading && models.length === 0 ? (
          <Box className="flex-1 items-center justify-center">
            <Spinner size="large" />
            <Text className="mt-4 text-typography-500">Searching Hugging Face...</Text>
          </Box>
        ) : (
          <FlashList
            data={displayModels}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <ModelCard 
                model={item}
                onDownload={handleDownload}
                onLoad={handleLoad}
                onUnload={unloadModel}
                onDelete={handleDelete}
                onCancel={cancelDownload}
                onChat={() => router.push('/chat')}
                isActive={engineState.activeModelId === item.id}
              />
            )}
            ListEmptyComponent={() => (
              <Box className="flex-1 items-center justify-center pt-20">
                <Text className="text-typography-400">No models found</Text>
              </Box>
            )}
          />
        )}
      </Box>

      {engineState.status === EngineStatus.INITIALIZING && (
        <Box className="absolute bottom-0 left-0 right-0 bg-primary-500 p-2 items-center flex-row justify-center">
          <Spinner className="text-white mr-2" />
          <Text className="text-white font-bold">Warming up model... {Math.round(engineState.loadProgress > 1 ? engineState.loadProgress : engineState.loadProgress * 100)}%</Text>
        </Box>
      )}
    </Box>
  );
};
