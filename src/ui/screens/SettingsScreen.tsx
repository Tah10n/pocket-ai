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
        gap: 14,
        marginBottom: 18,
    },
    resourceCard: {
        borderRadius: 18,
        borderWidth: 1,
        padding: 16,
        overflow: 'hidden',
    },
    resourceHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 16,
    },
    resourceTitleWrap: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        flex: 1,
    },
    resourceIcon: {
        width: 40,
        height: 40,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    resourceTitle: {
        fontSize: 17,
        fontWeight: '700',
    },
    resourceSubtitle: {
        marginTop: 3,
        fontSize: 12,
        lineHeight: 18,
    },
    primaryMetricRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 18,
    },
    primaryMetricCopy: {
        flex: 1,
    },
    primaryMetricValue: {
        fontSize: 28,
        fontWeight: '800',
        fontVariant: ['tabular-nums'],
    },
    primaryMetricLabel: {
        marginTop: 4,
        fontSize: 12,
        fontWeight: '600',
        lineHeight: 18,
    },
    metricAside: {
        minWidth: 110,
        borderRadius: 16,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 12,
        alignSelf: 'flex-start',
    },
    metricAsideLabel: {
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
    },
    metricAsideValue: {
        marginTop: 6,
        fontSize: 16,
        fontWeight: '800',
        fontVariant: ['tabular-nums'],
    },
    usageStack: {
        gap: 14,
    },
    usageMeter: {
        gap: 8,
    },
    usageLegendStack: {
        gap: 8,
    },
    usageTrack: {
        height: 10,
        borderRadius: 999,
        overflow: 'hidden',
        position: 'relative',
    },
    usageFill: {
        position: 'absolute',
        top: 0,
        left: 0,
        bottom: 0,
        borderRadius: 999,
    },
    usageDetailRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    usageDetailLabel: {
        flex: 1,
        fontSize: 12,
        fontWeight: '700',
        lineHeight: 16,
    },
    usageLegendLabelWrap: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    usageLegendDot: {
        width: 8,
        height: 8,
        borderRadius: 999,
        flexShrink: 0,
    },
    usageLegendLabel: {
        flexShrink: 1,
        fontSize: 12,
        fontWeight: '700',
        lineHeight: 16,
    },
    usageDetailValue: {
        fontSize: 12,
        fontWeight: '700',
        lineHeight: 16,
        textAlign: 'right',
        fontVariant: ['tabular-nums'],
    },
    resourceFooter: {
        marginTop: 18,
        paddingTop: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    unloadButton: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 12,
        borderWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    unloadButtonText: {
        fontSize: 13,
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

function UsageMeter({
    label,
    value,
    percentage,
    fillColor,
    trackBackground,
    labelColor,
    valueColor,
    testID,
}: {
    label: string;
    value: string;
    percentage: number;
    fillColor: string;
    trackBackground: string;
    labelColor: string;
    valueColor: string;
    testID: string;
}) {
    return (
        <View style={styles.usageMeter}>
            <View style={styles.usageDetailRow}>
                <Text style={[styles.usageDetailLabel, { color: labelColor }]}>{label}</Text>
                <Text style={[styles.usageDetailValue, { color: valueColor }]}>{value}</Text>
            </View>
            <View style={[styles.usageTrack, { backgroundColor: trackBackground }]}>
                <View
                    testID={testID}
                    style={[
                        styles.usageFill,
                        {
                            width: `${clampPercentage(percentage)}%`,
                            backgroundColor: fillColor,
                        },
                    ]}
                />
            </View>
        </View>
    );
}

function LayeredUsageMeter({
    rows,
    basePercentage,
    baseFillColor,
    overlayPercentage,
    overlayFillColor,
    trackBackground,
    labelColor,
    valueColor,
    trackTestID,
    baseTestID,
    overlayTestID,
}: {
    rows: {
        label: string;
        value: string;
        color: string;
    }[];
    basePercentage: number;
    baseFillColor: string;
    overlayPercentage: number;
    overlayFillColor: string;
    trackBackground: string;
    labelColor: string;
    valueColor: string;
    trackTestID: string;
    baseTestID: string;
    overlayTestID: string;
}) {
    return (
        <View style={styles.usageMeter}>
            <View style={styles.usageLegendStack}>
                {rows.map((row) => (
                    <View key={`${row.label}-${row.value}`} style={styles.usageDetailRow}>
                        <View style={styles.usageLegendLabelWrap}>
                            <View style={[styles.usageLegendDot, { backgroundColor: row.color }]} />
                            <Text style={[styles.usageLegendLabel, { color: labelColor }]}>{row.label}</Text>
                        </View>
                        <Text style={[styles.usageDetailValue, { color: valueColor }]}>{row.value}</Text>
                    </View>
                ))}
            </View>
            <View testID={trackTestID} style={[styles.usageTrack, { backgroundColor: trackBackground }]}>
                <View
                    testID={baseTestID}
                    style={[
                        styles.usageFill,
                        {
                            width: `${clampPercentage(basePercentage)}%`,
                            backgroundColor: baseFillColor,
                        },
                    ]}
                />
                <View
                    testID={overlayTestID}
                    style={[
                        styles.usageFill,
                        {
                            width: `${clampPercentage(overlayPercentage)}%`,
                            backgroundColor: overlayFillColor,
                        },
                    ]}
                />
            </View>
        </View>
    );
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
    const resourceCardBackground = isDark ? 'rgba(15, 23, 42, 0.95)' : '#ffffff';
    const resourceAsideBackground = isDark ? 'rgba(30, 41, 59, 0.82)' : '#f8fafc';
    const memoryAccent = colors.primary;
    const memoryAccentSoft = isDark ? '#8b7cff' : '#6d5efc';
    const storageAccent = isDark ? '#2dd4bf' : '#0f766e';
    const storageAccentSoft = isDark ? '#5eead4' : '#14b8a6';
    const destructiveBackground = isDark ? 'rgba(248, 113, 113, 0.14)' : 'rgba(239, 68, 68, 0.08)';
    const destructiveBorder = isDark ? 'rgba(248, 113, 113, 0.3)' : 'rgba(239, 68, 68, 0.18)';

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

    const ramTotalBytes = metrics?.ram.totalBytes ?? 0;
    const ramUsedBytes = metrics?.ram.usedBytes ?? 0;
    const ramAvailableBytes = metrics?.ram.availableBytes ?? 0;
    const ramAppUsedBytes = metrics?.ram.appUsedBytes ?? 0;
    const ramUsedPercentage = metrics?.ram.usedPercentage ?? 0;
    const ramAppUsedPercentage = ramTotalBytes > 0 ? (ramAppUsedBytes / ramTotalBytes) * 100 : 0;
    const isSystemRamSource = metrics?.ram.source === 'system';

    const storageTotalBytes = metrics?.storage.totalBytes ?? 0;
    const storageUsedBytes = metrics?.storage.usedBytes ?? 0;
    const storageFreeBytes = metrics?.storage.freeBytes ?? Math.max(storageTotalBytes - storageUsedBytes, 0);
    const storageUsedPercentage = metrics?.storage.usedPercentage ?? (storageTotalBytes > 0 ? (storageUsedBytes / storageTotalBytes) * 100 : 0);
    const appFilesBytes = appStorageMetrics?.appFilesBytes ?? 0;
    const appStoragePercentage = storageTotalBytes > 0 ? (appFilesBytes / storageTotalBytes) * 100 : 0;
    const canForceUnloadModel = isEngineReady && Boolean(engineState.activeModelId);
    const ramPrimaryValue = formatSystemCapacity(isSystemRamSource ? ramUsedBytes : ramAppUsedBytes);
    const ramPrimaryLabel = isSystemRamSource
        ? t('settings.memoryInUseOf', { total: formatSystemCapacity(ramTotalBytes) })
        : t('settings.memoryAppUsage');
    const ramAsideLabel = isSystemRamSource ? t('settings.available') : t('settings.deviceTotal');
    const ramAsideValue = formatSystemCapacity(isSystemRamSource ? ramAvailableBytes : ramTotalBytes);
    const ramSystemUsageSummary = formatPercent(ramUsedPercentage);
    const ramAppUsageSummary = formatSystemCapacity(ramAppUsedBytes);
    const ramUsedTrackPercentage = clampPercentage(ramUsedPercentage);
    const ramAppTrackPercentage = Math.min(clampPercentage(ramAppUsedPercentage), ramUsedTrackPercentage);
    const storageSystemUsageSummary = formatPercent(storageUsedPercentage);
    const storageAppUsageSummary = formatBytes(appFilesBytes);
    const storageUsedTrackPercentage = clampPercentage(storageUsedPercentage);
    const storageAppTrackPercentage = Math.min(clampPercentage(appStoragePercentage), storageUsedTrackPercentage);

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

                <View style={styles.resourcesWrap}>
                    <View
                        style={[
                            styles.resourceCard,
                            { backgroundColor: resourceCardBackground, borderColor: colors.border },
                            !isDark ? shadowStyles.light : null,
                        ]}
                    >
                        <View style={styles.resourceHeader}>
                            <View style={styles.resourceTitleWrap}>
                                <View style={[styles.resourceIcon, { backgroundColor: 'rgba(79, 70, 229, 0.12)' }]}>
                                    <MaterialSymbols name="memory" size={20} color={memoryAccent} />
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
                        </View>

                        <View style={styles.primaryMetricRow}>
                            <View style={styles.primaryMetricCopy}>
                                <Text style={[styles.primaryMetricValue, { color: colors.text }]}>
                                    {ramPrimaryValue}
                                </Text>
                                <Text style={[styles.primaryMetricLabel, { color: colors.textSecondary }]}>
                                    {ramPrimaryLabel}
                                </Text>
                            </View>
                            <View style={[styles.metricAside, { backgroundColor: resourceAsideBackground, borderColor: colors.border }]}>
                                <Text style={[styles.metricAsideLabel, { color: colors.textSecondary }]}>
                                    {ramAsideLabel}
                                </Text>
                                <Text style={[styles.metricAsideValue, { color: memoryAccent }]}>
                                    {ramAsideValue}
                                </Text>
                            </View>
                        </View>

                        <View style={styles.usageStack}>
                            {isSystemRamSource ? (
                                <LayeredUsageMeter
                                    rows={[
                                        {
                                            label: t('settings.systemUsage'),
                                            value: ramSystemUsageSummary,
                                            color: memoryAccent,
                                        },
                                        {
                                            label: t('settings.appMemory'),
                                            value: ramAppUsageSummary,
                                            color: memoryAccentSoft,
                                        },
                                    ]}
                                    basePercentage={ramUsedTrackPercentage}
                                    baseFillColor={memoryAccent}
                                    overlayPercentage={ramAppTrackPercentage}
                                    overlayFillColor={memoryAccentSoft}
                                    trackBackground={trackBackground}
                                    labelColor={colors.textSecondary}
                                    valueColor={colors.text}
                                    trackTestID="settings-memory-track"
                                    baseTestID="settings-memory-used-fill"
                                    overlayTestID="settings-memory-app-fill"
                                />
                            ) : null}
                            {!isSystemRamSource ? (
                                <UsageMeter
                                    label={t('settings.appMemory')}
                                    value={ramAppUsageSummary}
                                    percentage={ramAppUsedPercentage}
                                    fillColor={memoryAccentSoft}
                                    trackBackground={trackBackground}
                                    labelColor={colors.textSecondary}
                                    valueColor={colors.text}
                                    testID="settings-memory-app-fill"
                                />
                            ) : null}
                        </View>

                        {canForceUnloadModel ? (
                            <View style={[styles.resourceFooter, { borderTopColor: colors.border }]}>
                                <Pressable
                                    onPress={unloadActiveModel}
                                    style={[
                                        styles.unloadButton,
                                        {
                                            backgroundColor: destructiveBackground,
                                            borderColor: destructiveBorder,
                                        },
                                    ]}
                                >
                                    <MaterialSymbols name="close" size={18} color={colors.error} />
                                    <Text style={[styles.unloadButtonText, { color: colors.error }]}>
                                        {t('settings.forceUnloadModel')}
                                    </Text>
                                </Pressable>
                            </View>
                        ) : null}
                    </View>

                    <View
                        style={[
                            styles.resourceCard,
                            { backgroundColor: resourceCardBackground, borderColor: colors.border },
                            !isDark ? shadowStyles.light : null,
                        ]}
                    >
                        <View style={styles.resourceHeader}>
                            <View style={styles.resourceTitleWrap}>
                                <View style={[styles.resourceIcon, { backgroundColor: 'rgba(20, 184, 166, 0.12)' }]}>
                                    <MaterialSymbols name="storage" size={20} color={storageAccent} />
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
                        </View>

                        <View style={styles.primaryMetricRow}>
                            <View style={styles.primaryMetricCopy}>
                                <Text style={[styles.primaryMetricValue, { color: colors.text }]}>
                                    {formatSystemCapacity(storageUsedBytes)}
                                </Text>
                                <Text style={[styles.primaryMetricLabel, { color: colors.textSecondary }]}>
                                    {t('settings.storageUsedOf', { total: formatSystemCapacity(storageTotalBytes) })}
                                </Text>
                            </View>
                            <View style={[styles.metricAside, { backgroundColor: resourceAsideBackground, borderColor: colors.border }]}>
                                <Text style={[styles.metricAsideLabel, { color: colors.textSecondary }]}>
                                    {t('settings.free')}
                                </Text>
                                <Text style={[styles.metricAsideValue, { color: storageAccent }]}>
                                    {formatSystemCapacity(storageFreeBytes)}
                                </Text>
                            </View>
                        </View>

                        <View style={styles.usageStack}>
                            <LayeredUsageMeter
                                rows={[
                                    {
                                        label: t('settings.systemUsage'),
                                        value: storageSystemUsageSummary,
                                        color: storageAccent,
                                    },
                                    {
                                        label: t('settings.appFilesUsage'),
                                        value: storageAppUsageSummary,
                                        color: storageAccentSoft,
                                    },
                                ]}
                                basePercentage={storageUsedTrackPercentage}
                                baseFillColor={storageAccent}
                                overlayPercentage={storageAppTrackPercentage}
                                overlayFillColor={storageAccentSoft}
                                trackBackground={trackBackground}
                                labelColor={colors.textSecondary}
                                valueColor={colors.text}
                                trackTestID="settings-storage-track"
                                baseTestID="settings-storage-used-fill"
                                overlayTestID="settings-storage-app-fill"
                            />
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
