import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, Button, StyleSheet } from 'react-native';
import { localStorageRegistry } from '../../services/LocalStorageRegistry';
import { ModelMetadata } from '../../services/ModelCatalogService';

export function StorageManagerScreen() {
    const [downloadedModels, setDownloadedModels] = useState<ModelMetadata[]>([]);

    const loadModels = () => {
        setDownloadedModels(localStorageRegistry.getDownloadedModels());
    };

    useEffect(() => {
        loadModels();
    }, []);

    const handleDelete = async (id: string) => {
        await localStorageRegistry.removeModel(id);
        loadModels();
    };

    return (
        <View style={styles.container}>
            <Text style={styles.header}>Storage Manager</Text>
            <FlatList
                data={downloadedModels}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                    <View style={styles.item}>
                        <View>
                            <Text style={styles.title}>{item.name}</Text>
                            <Text>{(item.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB</Text>
                        </View>
                        <Button title="Offload" onPress={() => handleDelete(item.id)} color="red" />
                    </View>
                )}
                ListEmptyComponent={<Text>No downloaded models.</Text>}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, padding: 16 },
    header: { fontSize: 24, fontWeight: 'bold', marginBottom: 16 },
    item: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderColor: '#ccc' },
    title: { fontSize: 16, fontWeight: '600' }
});
