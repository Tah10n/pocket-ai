import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Button, StyleSheet, ActivityIndicator, Alert, TouchableOpacity, TextInput } from 'react-native';
import { modelCatalogService, ModelMetadata } from '../../services/ModelCatalogService';
import { modelDownloadManager, DownloadProgress } from '../../services/ModelDownloadManager';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/ThemeProvider';

export function ModelCatalogScreen() {
    const [models, setModels] = useState<ModelMetadata[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [progresses, setProgresses] = useState<DownloadProgress[]>([]);
    const [query, setQuery] = useState('');

    const requestIdRef = useRef(0);
    const { t } = useTranslation();
    const { colors } = useTheme();

    const loadModels = useCallback(async (q: string) => {
        const requestId = ++requestIdRef.current;
        try {
            setLoading(true);
            setError(null);
            const trimmed = q.trim();
            const available = await modelCatalogService.getAvailableModels(trimmed.length > 0 ? trimmed : undefined);
            if (requestId !== requestIdRef.current) return;
            setModels(available);
        } catch (e) {
            if (requestId !== requestIdRef.current) return;
            setModels([]);
            const message = t('models.loadFailed');
            setError(message);
            console.warn('[ModelCatalog] loadModels failed', e);
            Alert.alert('Error', message);
        } finally {
            if (requestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, [t]);

    useEffect(() => {
        const unsub = modelDownloadManager.subscribe((p) => setProgresses(p));
        return unsub;
    }, []);

    useEffect(() => {
        const delayMs = query.trim().length > 0 ? 400 : 0;
        const handle = setTimeout(() => loadModels(query), delayMs);
        return () => clearTimeout(handle);
    }, [query, loadModels]);

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

    const renderItem = ({ item }: { item: ModelMetadata }) => {
        const progress = progresses.find(p => p.modelId === item.id);
        const isDownloading = progress?.status === 'downloading' || progress?.status === 'pending';
        const isDone = progress?.status === 'done';
        const sizeLabel = item.sizeBytes > 0
            ? `${(item.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`
            : t('models.sizeUnknown');

        return (
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.title, { color: colors.text }]}>{item.name}</Text>
                <Text style={{ color: colors.textSecondary }}>Variant: {item.parameters}</Text>
                <Text style={{ color: colors.textSecondary }}>Context: {item.contextWindow}</Text>
                <Text style={{ color: colors.textSecondary }}>Size: {sizeLabel}</Text>

                <View style={styles.actions}>
                    {isDownloading ? (
                        <>
                            <Text style={{ color: colors.primary }}>
                                Downloading: {(progress.percent * 100).toFixed(1)}%
                            </Text>
                            <Button title={t('models.cancel')} color="red" onPress={() => handleCancel(item.id)} />
                        </>
                    ) : isDone ? (
                        <Text style={[styles.statusText, { color: colors.success }]}>{t('models.ready')}</Text>
                    ) : (
                        <Button title={t('models.download')} onPress={() => handleDownload(item)} />
                    )}
                </View>
            </View>
        );
    };

    const hasQuery = query.trim().length > 0;

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <View style={styles.headerRow}>
                <Text style={[styles.header, { color: colors.text }]}>{t('models.title')}</Text>
                {loading && models.length > 0 && <ActivityIndicator size="small" />}
            </View>

            <View style={styles.searchRow}>
                <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('models.searchPlaceholder')}
                    placeholderTextColor={colors.textSecondary}
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                    style={[
                        styles.searchInput,
                        {
                            backgroundColor: colors.inputBackground,
                            borderColor: colors.border,
                            color: colors.text,
                        },
                    ]}
                />

                {hasQuery && (
                    <TouchableOpacity
                        onPress={() => setQuery('')}
                        accessibilityRole="button"
                        accessibilityLabel={t('models.clearSearch')}
                        style={styles.clearButton}
                    >
                        <Text style={[styles.clearText, { color: colors.primary }]}>×</Text>
                    </TouchableOpacity>
                )}
            </View>

            <Text style={[styles.subheader, { color: colors.textSecondary }]}>
                {hasQuery ? t('models.searchResults') : t('models.featured')}
            </Text>

            {loading && models.length === 0 ? (
                <View style={styles.center}>
                    <ActivityIndicator size="large" />
                </View>
            ) : (
                <FlatList
                    data={models}
                    keyExtractor={item => item.id}
                    renderItem={renderItem}
                    contentContainerStyle={styles.list}
                    ListEmptyComponent={<Text style={{ color: colors.textSecondary }}>{error ?? t('models.noResults')}</Text>}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        paddingBottom: 8,
    },
    header: { fontSize: 24, fontWeight: 'bold' },
    subheader: { paddingHorizontal: 16, paddingBottom: 8 },
    searchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    searchInput: {
        flex: 1,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    clearButton: {
        marginLeft: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 10,
    },
    clearText: { fontSize: 18, fontWeight: '600' },
    list: { paddingHorizontal: 16, paddingBottom: 32 },
    card: {
        borderWidth: 1,
        borderRadius: 8,
        padding: 16,
        marginBottom: 16,
    },
    title: { fontSize: 18, fontWeight: 'bold', marginBottom: 6 },
    actions: {
        marginTop: 12,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    statusText: { fontWeight: 'bold', marginTop: 8 },
});



