import React, { useEffect, useState } from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { ModelMetadata } from '../../services/ModelCatalogService';
import { modelDownloadManager, DownloadProgress } from '../../services/ModelDownloadManager';
import { localStorageRegistry } from '../../services/LocalStorageRegistry';

interface Props {
    model: ModelMetadata;
}

export function ModelCard({ model }: Props) {
    const [progress, setProgress] = useState<DownloadProgress | null>(null);
    const isDownloaded = localStorageRegistry.isModelDownloaded(model.id);

    useEffect(() => {
        const unsub = modelDownloadManager.subscribe((progresses) => {
            const p = progresses.find(x => x.modelId === model.id);
            setProgress(p || null);
        });
        return unsub;
    }, [model.id]);

    const handleDownload = () => {
        modelDownloadManager.startDownload(model).catch(console.error);
    };

    const handleCancel = () => {
        modelDownloadManager.cancelDownload(model.id);
    };

    const isDownloading = progress && progress.status === 'downloading';

    return (
        <View style={styles.card}>
            <Text style={styles.title}>{model.name}</Text>
            <Text>Parameters: {model.parameters}</Text>
            <Text>Size: {(model.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB</Text>

            {isDownloaded ? (
                <Text style={styles.readyText}>Ready to use</Text>
            ) : progress && (progress.status === 'downloading' || progress.status === 'pending') ? (
                <View style={styles.progressContainer}>
                    <Text>Status: {progress.status}</Text>
                    <Text>{(progress.percent * 100).toFixed(1)}%</Text>
                    <Button title="Cancel" onPress={handleCancel} color="red" />
                </View>
            ) : (
                <Button title="Download" onPress={handleDownload} />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    card: { padding: 16, marginVertical: 8, borderWidth: 1, borderColor: '#ccc', borderRadius: 8 },
    title: { fontSize: 18, fontWeight: 'bold' },
    progressContainer: { marginTop: 8 },
    readyText: { color: 'green', fontWeight: 'bold', marginTop: 8 },
});
