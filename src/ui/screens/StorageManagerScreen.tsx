import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { useTheme } from '../../providers/ThemeProvider';
import { hardwareListenerService, type HardwareStatus } from '../../services/HardwareListenerService';
import {
    clearActiveCache,
    clearChatHistory,
    getAppStorageMetrics,
    offloadModel,
    resetAppSettings,
    type AppStorageMetrics,
} from '../../services/StorageManagerService';
import { getReportedErrorMessage } from '../../services/AppError';

const styles = StyleSheet.create({
    screen: { flex: 1, width: '100%', maxWidth: 768, alignSelf: 'center' },
    header: { borderBottomWidth: StyleSheet.hairlineWidth },
    headerBar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
    backButton: { height: 42, width: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
    headerTextWrap: { flex: 1 },
    headerTitle: { fontSize: 20, fontWeight: '700' },
    headerSubtitle: { marginTop: 2, fontSize: 12, lineHeight: 18 },
    content: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 32, gap: 16 },
    card: { borderWidth: 1, borderRadius: 22, padding: 16 },
    sectionTitle: { fontSize: 16, fontWeight: '700' },
    sectionSubtitle: { marginTop: 2, fontSize: 12, lineHeight: 18 },
    item: { borderWidth: 1, borderRadius: 18, padding: 14 },
    itemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    itemTitle: { fontSize: 15, fontWeight: '700' },
    itemSubtitle: { marginTop: 4, fontSize: 12, lineHeight: 18 },
    itemMeta: { marginTop: 8, fontSize: 12, fontWeight: '700' },
    button: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10 },
    buttonText: { fontSize: 12, fontWeight: '800' },
    activeBadge: { marginTop: 10, alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
    activeBadgeText: { fontSize: 11, fontWeight: '800' },
    warningTitle: { fontSize: 15, fontWeight: '700' },
    warningText: { marginTop: 6, fontSize: 13, lineHeight: 19 },
});

type BusyAction = 'cache' | 'chat' | 'settings' | `offload:${string}` | null;

function formatBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function ActionCard({
    title,
    description,
    meta,
    busy,
    disabled,
    buttonLabel,
    colors,
    mutedBackground,
    onPress,
}: {
    title: string;
    description: string;
    meta?: string;
    busy: boolean;
    disabled: boolean;
    buttonLabel: string;
    colors: { text: string; textSecondary: string; border: string; error: string };
    mutedBackground: string;
    onPress: () => void;
}) {
    return (
        <View style={[styles.item, { borderColor: colors.border, backgroundColor: mutedBackground, opacity: busy ? 0.7 : 1 }]}>
            <View style={styles.itemRow}>
                <View style={styles.headerTextWrap}>
                    <Text style={[styles.itemTitle, { color: colors.text }]}>{title}</Text>
                    <Text style={[styles.itemSubtitle, { color: colors.textSecondary }]}>{description}</Text>
                    {meta ? <Text style={[styles.itemMeta, { color: colors.textSecondary }]}>{meta}</Text> : null}
                </View>
                <Pressable
                    disabled={disabled}
                    onPress={onPress}
                    style={[styles.button, { backgroundColor: 'rgba(239, 68, 68, 0.12)' }]}
                >
                    <Text style={[styles.buttonText, { color: colors.error }]}>{buttonLabel}</Text>
                </Pressable>
            </View>
        </View>
    );
}

export function StorageManagerScreen() {
    const { t, i18n } = useTranslation();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const { colors, resolvedMode } = useTheme();
    const [appMetrics, setAppMetrics] = useState<AppStorageMetrics | null>(null);
    const [hardwareStatus, setHardwareStatus] = useState<HardwareStatus>(hardwareListenerService.getCurrentStatus());
    const [busyAction, setBusyAction] = useState<BusyAction>(null);
    const mountedRef = useRef(true);
    const canGoBack = router.canGoBack();

    const isDark = resolvedMode === 'dark';
    const cardBackground = isDark ? 'rgba(15, 23, 42, 0.72)' : colors.surface;
    const mutedBackground = isDark ? 'rgba(30, 41, 59, 0.85)' : '#eef2f7';
    const warningBackground = isDark ? 'rgba(127, 29, 29, 0.32)' : 'rgba(254, 226, 226, 0.9)';
    const warningBorder = isDark ? 'rgba(248, 113, 113, 0.38)' : 'rgba(248, 113, 113, 0.42)';
    const warningText = isDark ? '#fecaca' : '#991b1b';

    const loadAppMetrics = useCallback(async () => {
        const next = await getAppStorageMetrics();
        if (mountedRef.current) {
            setAppMetrics(next);
        }
    }, []);

    const refreshAll = useCallback(async () => {
        await loadAppMetrics();
    }, [loadAppMetrics]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => hardwareListenerService.subscribe(setHardwareStatus), []);

    useFocusEffect(
        useCallback(() => {
            void refreshAll();
        }, [refreshAll]),
    );

    const runBusyAction = useCallback(async (key: Exclude<BusyAction, null>, action: () => Promise<void>) => {
        try {
            setBusyAction(key);
            await action();
        } catch (error: any) {
            Alert.alert(
                t('storageManager.actionFailedTitle'),
                getReportedErrorMessage('StorageManagerScreen.runBusyAction', error, t),
            );
        } finally {
            if (mountedRef.current) {
                setBusyAction(null);
            }
            await refreshAll();
        }
    }, [refreshAll, t]);

    const handleDeleteModel = useCallback((modelId: string, modelName: string) => {
        Alert.alert(
            t('storageManager.deleteModelTitle'),
            t('storageManager.deleteModelMessage', { model: modelName }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: () => {
                        void runBusyAction(`offload:${modelId}`, async () => {
                            await offloadModel(modelId);
                        });
                    },
                },
            ],
        );
    }, [runBusyAction, t]);

    const handleClearCache = useCallback(() => {
        Alert.alert(
            t('storageManager.clearCacheTitle'),
            t('storageManager.clearCacheMessage'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.clear'),
                    style: 'destructive',
                    onPress: () => {
                        void runBusyAction('cache', async () => {
                            await clearActiveCache();
                        });
                    },
                },
            ],
        );
    }, [runBusyAction, t]);

    const handleClearChatHistory = useCallback(() => {
        Alert.alert(
            t('storageManager.clearChatHistoryTitle'),
            t('storageManager.clearChatHistoryMessage'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.clear'),
                    style: 'destructive',
                    onPress: () => {
                        void runBusyAction('chat', async () => {
                            clearChatHistory();
                        });
                    },
                },
            ],
        );
    }, [runBusyAction, t]);

    const handleResetSettings = useCallback(() => {
        Alert.alert(
            t('storageManager.resetSettingsTitle'),
            t('storageManager.resetSettingsMessage'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.reset'),
                    style: 'destructive',
                    onPress: () => {
                        void runBusyAction('settings', async () => {
                            const next = await resetAppSettings();
                            await i18n.changeLanguage(next.language);
                        });
                    },
                },
            ],
        );
    }, [i18n, runBusyAction, t]);

    const downloadedModels = appMetrics?.downloadedModels ?? [];

    return (
        <View style={[styles.screen, { backgroundColor: colors.background }]}>
            <View style={[styles.header, { paddingTop: insets.top, borderBottomColor: colors.border, backgroundColor: colors.background }]}>
                <View style={styles.headerBar}>
                    <Pressable
                        onPress={() => {
                            if (canGoBack) {
                                router.back();
                                return;
                            }
                            router.replace('/(tabs)/models' as any);
                        }}
                        style={[styles.backButton, { backgroundColor: mutedBackground }]}
                    >
                        <MaterialSymbols name="arrow-back-ios-new" size={18} color={colors.primary} />
                    </Pressable>
                    <View style={styles.headerTextWrap}>
                        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('storageManager.title')}</Text>
                        <Text style={[styles.headerSubtitle, { color: colors.textSecondary }]}>{t('storageManager.subtitle')}</Text>
                    </View>
                </View>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
                {hardwareStatus.isLowMemory ? (
                    <View style={[styles.card, { backgroundColor: warningBackground, borderColor: warningBorder }]}>
                        <Text style={[styles.warningTitle, { color: warningText }]}>{t('storageManager.lowMemoryTitle')}</Text>
                        <Text style={[styles.warningText, { color: warningText }]}>{t('storageManager.lowMemoryDescription')}</Text>
                    </View>
                ) : null}

                <View style={[styles.card, { backgroundColor: cardBackground, borderColor: colors.border }]}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('storageManager.actionsTitle')}</Text>
                    <Text style={[styles.sectionSubtitle, { color: colors.textSecondary, marginTop: 4 }]}>{t('storageManager.actionsDescription')}</Text>
                    <View style={{ gap: 12, marginTop: 16 }}>
                        <ActionCard title={t('storageManager.clearCacheTitle')} description={t('storageManager.clearCacheDescription')} meta={formatBytes(appMetrics?.cacheBytes ?? 0)} busy={busyAction === 'cache'} disabled={busyAction !== null} buttonLabel={busyAction === 'cache' ? t('common.loading') : t('common.clear')} colors={{ text: colors.text, textSecondary: colors.textSecondary, border: colors.border, error: colors.error }} mutedBackground={mutedBackground} onPress={handleClearCache} />
                        <ActionCard title={t('storageManager.clearChatHistoryTitle')} description={t('storageManager.clearChatHistoryDescription')} meta={formatBytes(appMetrics?.chatHistoryBytes ?? 0)} busy={busyAction === 'chat'} disabled={busyAction !== null} buttonLabel={busyAction === 'chat' ? t('common.loading') : t('common.clear')} colors={{ text: colors.text, textSecondary: colors.textSecondary, border: colors.border, error: colors.error }} mutedBackground={mutedBackground} onPress={handleClearChatHistory} />
                        <ActionCard title={t('storageManager.resetSettingsTitle')} description={t('storageManager.resetSettingsDescription')} busy={busyAction === 'settings'} disabled={busyAction !== null} buttonLabel={busyAction === 'settings' ? t('common.loading') : t('common.reset')} colors={{ text: colors.text, textSecondary: colors.textSecondary, border: colors.border, error: colors.error }} mutedBackground={mutedBackground} onPress={handleResetSettings} />
                    </View>
                </View>

                <View style={[styles.card, { backgroundColor: cardBackground, borderColor: colors.border }]}>
                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('storageManager.downloadedModelsTitle', { count: downloadedModels.length })}</Text>
                    <Text style={[styles.sectionSubtitle, { color: colors.textSecondary, marginTop: 4 }]}>{t('storageManager.downloadedModelsDescription')}</Text>
                    <View style={{ gap: 12, marginTop: 16 }}>
                        {downloadedModels.length === 0 ? (
                            <View style={[styles.item, { borderColor: colors.border, backgroundColor: mutedBackground }]}>
                                <Text style={[styles.itemTitle, { color: colors.text }]}>{t('storageManager.emptyModelsTitle')}</Text>
                                <Text style={[styles.itemSubtitle, { color: colors.textSecondary }]}>{t('storageManager.emptyModelsDescription')}</Text>
                            </View>
                        ) : downloadedModels.map((model) => {
                            const actionKey: BusyAction = `offload:${model.id}`;
                            const isActive = appMetrics?.activeModelId === model.id;
                            return (
                                <View key={model.id} style={[styles.item, { borderColor: colors.border, backgroundColor: mutedBackground }]}>
                                    <View style={styles.itemRow}>
                                        <View style={styles.headerTextWrap}>
                                            <Text style={[styles.itemTitle, { color: colors.text }]}>{model.name}</Text>
                                            <Text style={[styles.itemSubtitle, { color: colors.textSecondary }]}>{model.author} • {formatBytes(model.size)}</Text>
                                            {isActive ? (
                                                <View style={[styles.activeBadge, { backgroundColor: 'rgba(50, 17, 212, 0.12)' }]}>
                                                    <Text style={[styles.activeBadgeText, { color: colors.primary }]}>{t('storageManager.activeModelBadge')}</Text>
                                                </View>
                                            ) : null}
                                        </View>
                                        <Pressable
                                            disabled={busyAction !== null}
                                            onPress={() => handleDeleteModel(model.id, model.name)}
                                            style={[styles.button, { backgroundColor: 'rgba(239, 68, 68, 0.12)' }]}
                                        >
                                            <Text style={[styles.buttonText, { color: colors.error }]}>{busyAction === actionKey ? t('common.loading') : t('common.delete')}</Text>
                                        </Pressable>
                                    </View>
                                </View>
                            );
                        })}
                    </View>
                </View>
            </ScrollView>
        </View>
    );
}
