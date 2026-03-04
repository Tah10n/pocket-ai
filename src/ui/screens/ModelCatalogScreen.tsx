import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, Button, StyleSheet, ActivityIndicator, Alert, TouchableOpacity } from 'react-native';
import { modelCatalogService, ModelMetadata } from '../../services/ModelCatalogService';
import { modelDownloadManager, DownloadProgress } from '../../services/ModelDownloadManager';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/ThemeProvider';

export function ModelCatalogScreen() {
    const [models, setModels] = useState<ModelMetadata[]>([]);
    const [loading, setLoading] = useState(true);
    const [progresses, setProgresses] = useState<DownloadProgress[]>([]);
    const { t } = useTranslation();
    const { colors } = useTheme();

    useEffect(() => {
        loadModels();
        const unsub = modelDownloadManager.subscribe((p) => setProgresses(p));
        return unsub;
    }, []);

    const loadModels = async () => {
        try {
            setLoading(true);
            const available = await modelCatalogService.getAvailableModels();
            // Just for demonstration, we randomly mark some models as multimodal
            // In reality this would come from the HuggingFace tags
            const withMultimodal = available.map((m, i) => ({
                ...m,
                isMultimodal: i % 2 === 0
            }));
            setModels(withMultimodal);
        } catch (e) {
            Alert.alert('Error', 'Failed to load models');
        } finally {
            setLoading(false);
        }
    };

    const handleDownload = async (model: ModelMetadata) => {
        try {
            await modelDownloadManager.startDownload(model);
        } catch (e: any) {
            if (e.message === 'CELLULAR_DATA_WARNING') {
                Alert.alert('Warning', 'You are on a cellular network. Downloading large models is not recommended.');
            }
        }
    };

    const handleCancel = (modelId: string) => {
        modelDownloadManager.cancelDownload(modelId);
    };

    const renderItem = ({ item }: { item: ModelMetadata & { isMultimodal?: boolean } }) => {
        const progress = progresses.find(p => p.modelId === item.id);
        const isDownloading = progress?.status === 'downloading' || progress?.status === 'pending';
        const isDone = progress?.status === 'done';
        const sizeGB = (item.sizeBytes / 1024 / 1024 / 1024).toFixed(2);

        return (
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.cardHeader}>
                    <Text style={[styles.title, { color: colors.text }]}>{item.name}</Text>
                    {item.isMultimodal && (
                        <View style={styles.badge}>
                            <Text style={styles.badgeText}>Vision + Text</Text>
                        </View>
                    )}
                </View>
                <Text style={{ color: colors.text }}>Params: {item.parameters}</Text>
                <Text style={{ color: colors.text }}>Context: {item.contextWindow}</Text>
                <Text style={{ color: colors.text }}>Size: {sizeGB} GB</Text>

                <View style={styles.actions}>
                    {isDownloading ? (
                        <>
                            <Text style={{ color: colors.primary }}>
                                Downloading: {(progress.percent * 100).toFixed(1)}%
                            </Text>
                            <Button title={t('models.cancel')} color="red" onPress={() => handleCancel(item.id)} />
                        </>
                    ) : isDone ? (
                        <Text style={[styles.statusText, { color: 'green' }]}>{t('models.ready')}</Text>
                    ) : (
                        <Button title={t('models.download')} onPress={() => handleDownload(item)} />
                    )}
                </View>
            </View>
        );
    };

    if (loading) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <Text style={[styles.header, { color: colors.text }]}>{t('models.title')}</Text>
            <FlatList
                data={models}
                keyExtractor={item => item.id}
                renderItem={renderItem}
                contentContainerStyle={styles.list}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    header: { fontSize: 24, fontWeight: 'bold', padding: 16 },
    list: { paddingHorizontal: 16, paddingBottom: 32 },
    card: {
        borderWidth: 1,
        borderRadius: 8,
        padding: 16,
        marginBottom: 16,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 8
    },
    title: { fontSize: 18, fontWeight: 'bold', flex: 1 },
    badge: {
        backgroundColor: '#6200ee',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        marginLeft: 8
    },
    badgeText: { color: 'white', fontSize: 10, fontWeight: 'bold' },
    actions: {
        marginTop: 12,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    statusText: { fontWeight: 'bold', marginTop: 8 }
});
