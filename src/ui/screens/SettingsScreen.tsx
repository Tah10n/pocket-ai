import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ScreenHeaderShell } from '@/components/ui/ScreenShell';
import { useDeviceMetrics } from '../../hooks/useDeviceMetrics';
import { useLLMEngine } from '../../hooks/useLLMEngine';
import { useTheme } from '../../providers/ThemeProvider';
import { huggingFaceTokenService } from '../../services/HuggingFaceTokenService';
import { llmEngineService } from '../../services/LLMEngineService';
import { getAppStorageMetrics, type AppStorageMetrics } from '../../services/StorageManagerService';
import { getSettings, subscribeSettings, updateSettings } from '../../services/SettingsStore';

const styles = StyleSheet.create({
    screen: {
        flex: 1,
        width: '100%',
        maxWidth: 768,
        alignSelf: 'center',
    },
    scrollView: {
        flex: 1,
    },
    header: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    headerBar: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
    },
    backButton: {
        height: 42,
        width: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTextWrap: {
        flex: 1,
    },
    headerTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    iconBubble: {
        height: 36,
        width: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: '700',
    },
    scrollContent: {
        flexGrow: 1,
        paddingHorizontal: 16,
        paddingTop: 18,
    },
    sectionTitle: {
        marginLeft: 4,
        marginBottom: 6,
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 1,
    },
    card: {
        borderWidth: 1,
        borderRadius: 20,
        overflow: 'hidden',
        marginBottom: 18,
    },
    row: {
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    rowBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    rowTop: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    rowLeading: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: 12,
    },
    rowIcon: {
        width: 36,
        height: 36,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
    },
    rowTextWrap: {
        flex: 1,
    },
    rowTitle: {
        fontSize: 15,
        fontWeight: '600',
    },
    rowSubtitle: {
        marginTop: 4,
        fontSize: 12,
        lineHeight: 17,
    },
    rowTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    rowTrailingText: {
        marginRight: 4,
        fontSize: 14,
        fontWeight: '600',
    },
    segmentedControl: {
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        borderRadius: 14,
        padding: 4,
        marginTop: 12,
    },
    segmentButton: {
        flex: 1,
        minHeight: 40,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
    },
    segmentText: {
        fontSize: 13,
        fontWeight: '700',
    },
    resourcesWrap: {
        padding: 14,
        gap: 12,
    },
    resourceCard: {
        borderRadius: 20,
        borderWidth: 1,
        padding: 14,
    },
    resourceHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
    },
    resourceTitleWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: 12,
    },
    resourceIcon: {
        width: 36,
        height: 36,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
    },
    resourceTitle: {
        fontSize: 16,
        fontWeight: '700',
    },
    resourceSubtitle: {
        marginTop: 2,
        fontSize: 12,
        lineHeight: 17,
    },
    percentBadge: {
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    percentBadgeText: {
        fontSize: 12,
        fontWeight: '800',
    },
    primaryMetricRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    primaryMetricValue: {
        fontSize: 28,
        fontWeight: '800',
    },
    primaryMetricLabel: {
        marginTop: 2,
        fontSize: 12,
        fontWeight: '600',
    },
    primaryMetricHint: {
        fontSize: 12,
        fontWeight: '700',
    },
    usageTrack: {
        height: 12,
        borderRadius: 999,
        overflow: 'hidden',
    },
    usageFill: {
        height: '100%',
        borderRadius: 999,
    },
    usageLegendRow: {
        marginTop: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    usageLegendText: {
        fontSize: 12,
        fontWeight: '600',
    },
    statGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginTop: 12,
        marginHorizontal: -4,
    },
    statChip: {
        width: '50%',
        paddingHorizontal: 4,
        paddingBottom: 6,
    },
    statChipInner: {
        borderRadius: 16,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    statChipLabel: {
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
    },
    statChipValue: {
        marginTop: 4,
        fontSize: 15,
        fontWeight: '700',
    },
    unloadButton: {
        marginTop: 6,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
    },
    unloadButtonText: {
        fontSize: 14,
        fontWeight: '700',
    },
});

function clampPercentage(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(100, value));
}

function formatSystemCapacity(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return '0 MB';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unitIndex = 0;

    while (size >= 1000 && unitIndex < units.length - 1) {
        size /= 1000;
        unitIndex += 1;
    }

    const precision = unitIndex >= 3 ? 1 : (size >= 10 || unitIndex === 0 ? 0 : 1);
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return '0 MB';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatPercent(value: number) {
    return `${Math.round(clampPercentage(value))}%`;
}

export const SettingsScreen = () => {
    const { t, i18n } = useTranslation();
    const router = useRouter();
    const tabBarHeight = useBottomTabBarHeight();
    const isFocused = useIsFocused();
    const { mode, resolvedMode, setTheme, colors } = useTheme();
    const { metrics, refresh } = useDeviceMetrics({ enabled: isFocused, refreshIntervalMs: 1000 });
    const { state: engineState, isReady: isEngineReady } = useLLMEngine();
    const [settings, setSettings] = useState(() => getSettings());
    const [appStorageMetrics, setAppStorageMetrics] = useState<AppStorageMetrics | null>(null);
    const [hasHuggingFaceToken, setHasHuggingFaceToken] = useState(() => huggingFaceTokenService.getCachedState().hasToken);

    const isDark = resolvedMode === 'dark';
    const canGoBack = router.canGoBack();
    const cardBackground = isDark ? 'rgba(15, 23, 42, 0.72)' : colors.surface;
    const mutedBackground = isDark ? 'rgba(30, 41, 59, 0.85)' : '#eef2f7';
    const selectedBackground = isDark ? '#111827' : '#ffffff';
    const trackBackground = isDark ? 'rgba(51, 65, 85, 0.9)' : '#e2e8f0';
    const resourceCardBackground = isDark ? 'rgba(15, 23, 42, 0.95)' : '#f8fafc';

    useEffect(() => {
        return subscribeSettings((nextSettings) => {
            setSettings(nextSettings);
        });
    }, []);

    useEffect(() => {
        return huggingFaceTokenService.subscribe((state) => {
            setHasHuggingFaceToken(state.hasToken);
        });
    }, []);

    useFocusEffect(
        useCallback(() => {
            void refresh();
        }, [refresh]),
    );

    useFocusEffect(
        useCallback(() => {
            let isActive = true;

            const loadAppStorageMetrics = async () => {
                const nextMetrics = await getAppStorageMetrics();
                if (isActive) {
                    setAppStorageMetrics(nextMetrics);
                }
            };

            void loadAppStorageMetrics();

            return () => {
                isActive = false;
            };
        }, []),
    );

    const handleLanguagePress = () => {
        const nextLang = settings.language === 'en' ? 'ru' : 'en';
        updateSettings({ language: nextLang });
        i18n.changeLanguage(nextLang);
    };

    const handlePresetsPress = () => {
        router.push('/presets' as any);
    };

    const handleStorageManagerPress = () => {
        router.push('/storage' as any);
    };

    const handleLegalPress = () => {
        router.push('/legal' as any);
    };

    const handleHuggingFaceTokenPress = () => {
        router.push('/huggingface-token' as any);
    };

    const unloadActiveModel = async () => {
        await llmEngineService.unload();
        await refresh();
    };

    const renderThemeButton = (themeMode: 'light' | 'dark' | 'system', label: string) => {
        const isSelected = mode === themeMode;

        return (
            <Pressable
                key={themeMode}
                onPress={() => setTheme(themeMode)}
                style={[
                    styles.segmentButton,
                    { backgroundColor: isSelected ? selectedBackground : 'transparent' },
                    !isDark && isSelected ? shadowStyles.light : null,
                ]}
            >
                <Text
                    style={[
                        styles.segmentText,
                        {
                            color: isSelected ? colors.primary : colors.textSecondary,
                        },
                    ]}
                >
                    {label}
                </Text>
            </Pressable>
        );
    };

    const renderStatChip = (key: string, label: string, value: string) => (
        <View key={key} style={styles.statChip}>
            <View style={[styles.statChipInner, { borderColor: colors.border, backgroundColor: mutedBackground }]}>
                <Text style={[styles.statChipLabel, { color: colors.textSecondary }]}>{label}</Text>
                <Text style={[styles.statChipValue, { color: colors.text }]}>{value}</Text>
            </View>
        </View>
    );

    const ramTotalBytes = metrics?.ram.totalBytes ?? 0;
    const ramUsedBytes = metrics?.ram.usedBytes ?? 0;
    const ramAvailableBytes = metrics?.ram.availableBytes ?? 0;
    const ramAppUsedBytes = metrics?.ram.appUsedBytes ?? 0;
    const ramUsedPercentage = metrics?.ram.usedPercentage ?? 0;
    const isSystemRamSource = metrics?.ram.source === 'system';

    const storageTotalBytes = metrics?.storage.totalBytes ?? 0;
    const storageUsedBytes = metrics?.storage.usedBytes ?? 0;
    const storageFreeBytes = metrics?.storage.freeBytes ?? Math.max(storageTotalBytes - storageUsedBytes, 0);
    const storageUsedPercentage = metrics?.storage.usedPercentage ?? (storageTotalBytes > 0 ? (storageUsedBytes / storageTotalBytes) * 100 : 0);
    const appFilesBytes = appStorageMetrics?.appFilesBytes ?? 0;
    const canForceUnloadModel = isEngineReady && Boolean(engineState.activeModelId);
    const ramPrimaryValue = formatSystemCapacity(isSystemRamSource ? ramUsedBytes : ramAppUsedBytes);
    const ramPrimaryLabel = isSystemRamSource
        ? t('settings.memoryInUseOf', { total: formatSystemCapacity(ramTotalBytes) })
        : t('settings.memoryAppUsage');
    const ramPrimaryHint = isSystemRamSource
        ? t('settings.memoryAvailable', { value: formatSystemCapacity(ramAvailableBytes) })
        : t('settings.memoryDeviceTotal', { value: formatSystemCapacity(ramTotalBytes) });
    const ramStatItems = isSystemRamSource
        ? [
            { key: 'ram-used', label: t('settings.used'), value: formatSystemCapacity(ramUsedBytes) },
            { key: 'ram-available', label: t('settings.available'), value: formatSystemCapacity(ramAvailableBytes) },
            { key: 'ram-total', label: t('settings.total'), value: formatSystemCapacity(ramTotalBytes) },
            { key: 'ram-app', label: t('settings.appMemory'), value: formatSystemCapacity(ramAppUsedBytes) },
        ]
        : [
            { key: 'ram-app', label: t('settings.appMemory'), value: formatSystemCapacity(ramAppUsedBytes) },
            { key: 'ram-device-total', label: t('settings.deviceTotal'), value: formatSystemCapacity(ramTotalBytes) },
        ];

    return (
        <View style={{ flex: 1, backgroundColor: colors.background }}>
            <ScreenHeaderShell>
                <View style={styles.headerBar}>
                    <Pressable
                        testID="settings-back-button"
                        onPress={() => {
                            if (canGoBack) {
                                router.back();
                                return;
                            }

                            router.replace('/' as any);
                        }}
                        style={[styles.backButton, { backgroundColor: mutedBackground }]}
                    >
                        <MaterialSymbols name="arrow-back-ios-new" size={18} color={colors.primary} />
                    </Pressable>
                    <View style={styles.headerTextWrap}>
                        <View style={styles.headerTitleRow}>
                            <View style={[styles.iconBubble, { backgroundColor: 'rgba(50, 17, 212, 0.10)' }]}>
                                <MaterialSymbols name="settings" size={22} color={colors.primary} />
                            </View>
                            <Text style={[styles.headerTitle, { color: colors.text }]}>
                                {t('settings.title')}
                            </Text>
                        </View>
                    </View>
                </View>
            </ScreenHeaderShell>

            <View style={styles.screen}>
                <ScrollView
                    style={styles.scrollView}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={[styles.scrollContent, { paddingBottom: tabBarHeight + 24 }]}
                >
                    <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                        {t('settings.appearance')}
                    </Text>

                    <View style={[styles.card, { backgroundColor: cardBackground, borderColor: colors.border }]}>
                        <View style={[styles.row, styles.rowBorder, { borderBottomColor: colors.border }]}>
                            <View style={styles.rowTop}>
                                <View style={styles.rowLeading}>
                                    <View style={[styles.rowIcon, { backgroundColor: 'rgba(59, 130, 246, 0.18)' }]}>
                                        <MaterialSymbols name="palette" size={20} color={colors.primary} />
                                    </View>
                                    <View style={styles.rowTextWrap}>
                                        <Text style={[styles.rowTitle, { color: colors.text }]}>
                                            {t('settings.themeMode')}
                                        </Text>
                                        <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                                            {t('settings.themeDescription')}
                                        </Text>
                                    </View>
                                </View>
                            </View>
                            <View style={[styles.segmentedControl, { backgroundColor: mutedBackground }]}>
                                {renderThemeButton('light', t('settings.themeLight'))}
                                {renderThemeButton('system', t('settings.themeSystem'))}
                                {renderThemeButton('dark', t('settings.themeDark'))}
                            </View>
                        </View>
                        <Pressable onPress={handleLanguagePress} style={styles.row}>
                            <View style={styles.rowTop}>
                                <View style={styles.rowLeading}>
                                    <View style={[styles.rowIcon, { backgroundColor: 'rgba(50, 17, 212, 0.18)' }]}>
                                        <MaterialSymbols name="language" size={20} color={colors.primary} />
                                    </View>
                                    <View style={styles.rowTextWrap}>
                                        <Text style={[styles.rowTitle, { color: colors.text }]}>
                                            {t('settings.language')}
                                        </Text>
                                        <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                                            {t('settings.languageDescription')}
                                        </Text>
                                    </View>
                                </View>
                                <View style={styles.rowTrailing}>
                                    <Text style={[styles.rowTrailingText, { color: colors.primary }]}>
                                        {settings.language === 'en' ? t('settings.languageEnglish') : t('settings.languageRussian')}
                                    </Text>
                                    <MaterialSymbols name="chevron-right" size={20} color={colors.textSecondary} />
                                </View>
                            </View>
                        </Pressable>
                    </View>

                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                    {t('settings.systemConfiguration')}
                </Text>

                <View style={[styles.card, { backgroundColor: cardBackground, borderColor: colors.border }]}>
                    <Pressable onPress={handlePresetsPress} style={[styles.row, styles.rowBorder, { borderBottomColor: colors.border }]}>
                        <View style={styles.rowTop}>
                            <View style={styles.rowLeading}>
                                <View style={[styles.rowIcon, { backgroundColor: 'rgba(245, 158, 11, 0.18)' }]}>
                                    <MaterialSymbols name="tune" size={20} color={colors.warning} />
                                </View>
                                <View style={styles.rowTextWrap}>
                                    <Text style={[styles.rowTitle, { color: colors.text }]}>
                                        {t('settings.presets')}
                                    </Text>
                                    <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                                        {t('settings.presetsDescription')}
                                    </Text>
                                </View>
                            </View>

                            <MaterialSymbols name="chevron-right" size={20} color={colors.textSecondary} />
                        </View>
                    </Pressable>

                    <Pressable onPress={handleStorageManagerPress} style={[styles.row, styles.rowBorder, { borderBottomColor: colors.border }]}>
                        <View style={styles.rowTop}>
                            <View style={styles.rowLeading}>
                                <View style={[styles.rowIcon, { backgroundColor: 'rgba(20, 184, 166, 0.18)' }]}>
                                    <MaterialSymbols name="storage" size={20} color="#0f766e" />
                                </View>
                                <View style={styles.rowTextWrap}>
                                    <Text style={[styles.rowTitle, { color: colors.text }]}>
                                        {t('settings.storageManager')}
                                    </Text>
                                    <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                                        {t('settings.storageManagerDescription')}
                                    </Text>
                                </View>
                            </View>

                            <MaterialSymbols name="chevron-right" size={20} color={colors.textSecondary} />
                        </View>
                    </Pressable>

                    <Pressable onPress={handleHuggingFaceTokenPress} style={[styles.row, styles.rowBorder, { borderBottomColor: colors.border }]}>
                        <View style={styles.rowTop}>
                            <View style={styles.rowLeading}>
                                <View style={[styles.rowIcon, { backgroundColor: 'rgba(99, 102, 241, 0.16)' }]}>
                                    <MaterialSymbols name="key" size={20} color={colors.primary} />
                                </View>
                                <View style={styles.rowTextWrap}>
                                    <Text style={[styles.rowTitle, { color: colors.text }]}>
                                        {t('settings.huggingFaceToken')}
                                    </Text>
                                    <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                                        {t('settings.huggingFaceTokenDescription')}
                                    </Text>
                                </View>
                            </View>

                            <View style={styles.rowTrailing}>
                                <Text style={[styles.rowTrailingText, { color: colors.primary }]}>
                                    {hasHuggingFaceToken
                                        ? t('settings.huggingFaceTokenConfigured')
                                        : t('settings.huggingFaceTokenMissing')}
                                </Text>
                                <MaterialSymbols name="chevron-right" size={20} color={colors.textSecondary} />
                            </View>
                        </View>
                    </Pressable>

                    <Pressable onPress={handleLegalPress} style={styles.row}>
                        <View style={styles.rowTop}>
                            <View style={styles.rowLeading}>
                                <View style={[styles.rowIcon, { backgroundColor: 'rgba(50, 17, 212, 0.18)' }]}>
                                    <MaterialSymbols name="security" size={20} color={colors.primary} />
                                </View>
                                <View style={styles.rowTextWrap}>
                                    <Text style={[styles.rowTitle, { color: colors.text }]}>
                                        {t('settings.privacyDisclosures')}
                                    </Text>
                                    <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                                        {t('settings.privacyDisclosuresDescription')}
                                    </Text>
                                </View>
                            </View>

                            <MaterialSymbols name="chevron-right" size={20} color={colors.textSecondary} />
                        </View>
                    </Pressable>
                </View>

                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                    {t('settings.resources')}
                </Text>

                <View style={[styles.card, { backgroundColor: cardBackground, borderColor: colors.border }]}>
                    <View style={styles.resourcesWrap}>
                        <View style={[styles.resourceCard, { backgroundColor: resourceCardBackground, borderColor: colors.border }]}>
                            <View style={styles.resourceHeader}>
                                <View style={styles.resourceTitleWrap}>
                                    <View style={[styles.resourceIcon, { backgroundColor: 'rgba(79, 70, 229, 0.14)' }]}>
                                        <MaterialSymbols name="memory" size={20} color={colors.primary} />
                                    </View>
                                    <View style={styles.rowTextWrap}>
                                        <Text style={[styles.resourceTitle, { color: colors.text }]}>
                                            {t('settings.memoryTitle')}
                                        </Text>
                                        <Text style={[styles.resourceSubtitle, { color: colors.textSecondary }]}>
                                            {t(isSystemRamSource ? 'settings.memoryDescription' : 'settings.memoryDescriptionFallback')}
                                        </Text>
                                    </View>
                                </View>

                                {isSystemRamSource ? (
                                    <View style={[styles.percentBadge, { backgroundColor: 'rgba(79, 70, 229, 0.12)' }]}>
                                        <Text style={[styles.percentBadgeText, { color: colors.primary }]}>
                                            {formatPercent(ramUsedPercentage)}
                                        </Text>
                                    </View>
                                ) : null}
                            </View>

                            <View style={styles.primaryMetricRow}>
                                <View>
                                    <Text style={[styles.primaryMetricValue, { color: colors.text }]}>
                                        {ramPrimaryValue}
                                    </Text>
                                    <Text style={[styles.primaryMetricLabel, { color: colors.textSecondary }]}>
                                        {ramPrimaryLabel}
                                    </Text>
                                </View>
                                <Text style={[styles.primaryMetricHint, { color: colors.primary }]}>
                                    {ramPrimaryHint}
                                </Text>
                            </View>

                            {isSystemRamSource ? (
                                <>
                                    <View style={[styles.usageTrack, { backgroundColor: trackBackground }]}>
                                        <View
                                            style={[
                                                styles.usageFill,
                                                {
                                                    width: `${clampPercentage(ramUsedPercentage)}%`,
                                                    backgroundColor: '#4f46e5',
                                                },
                                            ]}
                                        />
                                    </View>
                                    <View style={styles.usageLegendRow}>
                                        <Text style={[styles.usageLegendText, { color: colors.textSecondary }]}>
                                            {t('settings.memoryBusy')}
                                        </Text>
                                    </View>
                                </>
                            ) : null}

                            <View style={styles.statGrid}>
                                {ramStatItems.map((item) => renderStatChip(item.key, item.label, item.value))}
                            </View>

                            <Pressable
                                disabled={!canForceUnloadModel}
                                onPress={canForceUnloadModel ? unloadActiveModel : undefined}
                                style={[
                                    styles.unloadButton,
                                    {
                                        backgroundColor: canForceUnloadModel ? 'rgba(239, 68, 68, 0.12)' : mutedBackground,
                                        opacity: canForceUnloadModel ? 1 : 0.55,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.unloadButtonText,
                                        { color: canForceUnloadModel ? colors.error : colors.textSecondary },
                                    ]}
                                >
                                    {t('settings.forceUnloadModel')}
                                </Text>
                            </Pressable>
                        </View>

                        <View style={[styles.resourceCard, { backgroundColor: resourceCardBackground, borderColor: colors.border }]}>
                            <View style={styles.resourceHeader}>
                                <View style={styles.resourceTitleWrap}>
                                    <View style={[styles.resourceIcon, { backgroundColor: 'rgba(20, 184, 166, 0.14)' }]}>
                                        <MaterialSymbols name="storage" size={20} color="#0f766e" />
                                    </View>
                                    <View style={styles.rowTextWrap}>
                                        <Text style={[styles.resourceTitle, { color: colors.text }]}>
                                            {t('settings.storageTitle')}
                                        </Text>
                                        <Text style={[styles.resourceSubtitle, { color: colors.textSecondary }]}>
                                            {t('settings.storageDescription')}
                                        </Text>
                                    </View>
                                </View>

                                <View style={[styles.percentBadge, { backgroundColor: 'rgba(20, 184, 166, 0.12)' }]}>
                                    <Text style={[styles.percentBadgeText, { color: '#0f766e' }]}>
                                        {formatPercent(storageUsedPercentage)}
                                    </Text>
                                </View>
                            </View>

                            <View style={styles.primaryMetricRow}>
                                <View>
                                    <Text style={[styles.primaryMetricValue, { color: colors.text }]}>
                                        {formatSystemCapacity(storageUsedBytes)}
                                    </Text>
                                    <Text style={[styles.primaryMetricLabel, { color: colors.textSecondary }]}>
                                        {t('settings.storageUsedOf', { total: formatSystemCapacity(storageTotalBytes) })}
                                    </Text>
                                </View>
                                <Text style={[styles.primaryMetricHint, { color: '#0f766e' }]}>
                                    {t('settings.storageFree', { value: formatSystemCapacity(storageFreeBytes) })}
                                </Text>
                            </View>

                            <View style={[styles.usageTrack, { backgroundColor: trackBackground }]}>
                                <View
                                    style={[
                                        styles.usageFill,
                                        {
                                            width: `${clampPercentage(storageUsedPercentage)}%`,
                                            backgroundColor: '#14b8a6',
                                        },
                                    ]}
                                />
                            </View>
                            <View style={styles.usageLegendRow}>
                                <Text style={[styles.usageLegendText, { color: colors.textSecondary }]}>
                                    {t('settings.storageOccupied')}
                                </Text>
                            </View>

                            <View style={styles.statGrid}>
                                {renderStatChip('storage-used', t('settings.used'), formatSystemCapacity(storageUsedBytes))}
                                {renderStatChip('storage-free', t('settings.free'), formatSystemCapacity(storageFreeBytes))}
                                {renderStatChip('storage-total', t('settings.total'), formatSystemCapacity(storageTotalBytes))}
                                {renderStatChip('storage-app-files', t('settings.appFilesUsage'), formatBytes(appFilesBytes))}
                            </View>
                        </View>
                    </View>
                </View>
                </ScrollView>
            </View>
        </View>
    );
};

const shadowStyles = StyleSheet.create({
    light: {
        shadowColor: '#0f172a',
        shadowOpacity: 0.08,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 2,
    },
});
