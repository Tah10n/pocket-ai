import React, { useEffect, useState } from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { FlashList } from '@shopify/flash-list';
import { localStorageRegistry } from '../../services/LocalStorageRegistry';
import { ModelMetadata } from '../../services/ModelCatalogService';

export function StorageManagerScreen() {
    const [downloadedModels, setDownloadedModels] = useState<ModelMetadata[]>([]);

    const loadModels = () => {
        setDownloadedModels(localStorageRegistry.getDownloadedModels());
    };

    useEffect(() => {
        loadModels();
        return localStorageRegistry.subscribe(loadModels);
    }, []);

    const handleDelete = async (id: string) => {
        await localStorageRegistry.removeModel(id);
        loadModels();
    };

    return (
        <Box className="flex-1 p-4 bg-background-0 dark:bg-background-950">
            <Text className="text-2xl font-bold mb-4 text-typography-900 dark:text-typography-100">Storage Manager</Text>
            <Box className="flex-1 w-full flex">
                <FlashList
                    data={downloadedModels}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <Box className="flex-row justify-between py-3 border-b border-outline-200 dark:border-outline-800">
                            <Box>
                                <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">{item.name}</Text>
                                <Text className="text-typography-600 dark:text-typography-400">{(item.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB</Text>
                            </Box>
                            <Button action="negative" size="sm" onPress={() => handleDelete(item.id)}>
                                <ButtonText>Offload</ButtonText>
                            </Button>
                        </Box>
                    )}
                    ListEmptyComponent={<Text className="text-typography-500 mt-4 text-center">No downloaded models.</Text>}
                />
            </Box>
        </Box>
    );
}
