import React, { useCallback, useEffect, useState } from 'react';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import {
    ScreenCard,
    ScreenContent,
    ScreenPressableCard,
    ScreenSectionLabel,
    ScreenSegmentedControl,
    ScreenStack,
} from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { useDeviceMetrics } from '../../hooks/useDeviceMetrics';
import { useLLMEngine } from '../../hooks/useLLMEngine';
import { useTheme } from '../../providers/ThemeProvider';
import { huggingFaceTokenService } from '../../services/HuggingFaceTokenService';
import { llmEngineService } from '../../services/LLMEngineService';
import { getAppStorageMetrics, type AppStorageMetrics } from '../../services/StorageManagerService';
import { getSettings, subscribeSettings, updateSettings } from '../../services/SettingsStore';
import { semanticColorTokens, withAlpha } from '../../utils/themeTokens';

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

function SettingsNavCard({
    title,
    description,
    iconName,
    iconWrapClassName,
    iconClassName,
    trailingText,
    onPress,
}: {
    title: string;
    description: string;
    iconName: React.ComponentProps<typeof MaterialSymbols>['name'];
    iconWrapClassName: string;
    iconClassName: string;
    trailingText?: string;
    onPress: () => void;
}) {
    return (
        <ScreenPressableCard onPress={onPress} variant="inset" padding="compact">
            <Box className="flex-row items-center gap-3">
                <Box className={`h-10 w-10 items-center justify-center rounded-2xl ${iconWrapClassName}`}>
                    <MaterialSymbols name={iconName} size={20} className={iconClassName} />
                </Box>

                <Box className="min-w-0 flex-1">
                    <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                        {title}
                    </Text>
                    <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                        {description}
                    </Text>
                </Box>

                <Box className="shrink-0 flex-row items-center gap-1">
                    {trailingText ? (
                        <Text className="text-sm font-semibold text-primary-500">
                            {trailingText}
                        </Text>
                    ) : null}
                    <MaterialSymbols name="chevron-right" size={20} className="text-typography-400 dark:text-typography-500" />
                </Box>
            </Box>
        </ScreenPressableCard>
    );
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
        <Box className="gap-2">
            <Box className="flex-row items-center justify-between gap-3">
                <Text className="flex-1 text-xs font-semibold leading-4" style={{ color: labelColor }}>
                    {label}
                </Text>
                <Text className="text-xs font-semibold leading-4 text-right" style={{ color: valueColor }}>
                    {value}
                </Text>
            </Box>
            <Box className="h-2.5 overflow-hidden rounded-full" style={{ backgroundColor: trackBackground }}>
                <Box
                    testID={testID}
                    className="h-full rounded-full"
                    style={{
                        width: `${clampPercentage(percentage)}%`,
                        backgroundColor: fillColor,
                    }}
                />
            </Box>
        </Box>
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
        <Box className="gap-2">
            <ScreenStack gap="compact">
                {rows.map((row) => (
                    <Box key={`${row.label}-${row.value}`} className="flex-row items-center justify-between gap-3">
                        <Box className="flex-1 flex-row items-center gap-2">
                            <Box className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
                            <Text className="flex-1 text-xs font-semibold leading-4" style={{ color: labelColor }}>
                                {row.label}
                            </Text>
                        </Box>
                        <Text className="text-xs font-semibold leading-4 text-right" style={{ color: valueColor }}>
                            {row.value}
                        </Text>
                    </Box>
                ))}
            </ScreenStack>
            <Box testID={trackTestID} className="h-2.5 overflow-hidden rounded-full" style={{ backgroundColor: trackBackground }}>
                <Box
                    testID={baseTestID}
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                        width: `${clampPercentage(basePercentage)}%`,
                        backgroundColor: baseFillColor,
                    }}
                />
                <Box
                    testID={overlayTestID}
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                        width: `${clampPercentage(overlayPercentage)}%`,
                        backgroundColor: overlayFillColor,
                    }}
                />
            </Box>
        </Box>
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
    const trackBackground = isDark ? withAlpha(semanticColorTokens.outline[700], 0.9) : semanticColorTokens.outline[200];
    const resourceAsideBackground = isDark ? withAlpha(semanticColorTokens.background[800], 0.82) : semanticColorTokens.background[50];
    const memoryAccent = colors.primary;
    const memoryAccentSoft = isDark ? semanticColorTokens.primary[300] : semanticColorTokens.primary[400];
    const storageAccent = colors.success;
    const storageAccentSoft = isDark ? semanticColorTokens.success[300] : semanticColorTokens.success[400];

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

    const themeOptions = [
        { key: 'light', label: t('settings.themeLight') },
        { key: 'system', label: t('settings.themeSystem') },
        { key: 'dark', label: t('settings.themeDark') },
    ];

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950">
            <HeaderBar
                title={t('settings.title')}
                onBack={undefined}
                backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
                backButtonTestID="settings-back-button"
                showBrand
                brandIconName="settings"
            />

            <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
                <ScreenContent style={{ paddingTop: 18, paddingBottom: tabBarHeight + 24 }}>
                    <ScreenStack gap="loose">
                        <Box>
                            <ScreenSectionLabel>{t('settings.appearance')}</ScreenSectionLabel>
                            <ScreenStack className="mt-2">
                                <ScreenCard>
                                    <Box className="flex-row items-start gap-3">
                                        <Box className="h-10 w-10 items-center justify-center rounded-2xl bg-info-500/10 dark:bg-info-500/20">
                                            <MaterialSymbols name="palette" size={20} className="text-info-600 dark:text-info-300" />
                                        </Box>
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.themeMode')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t('settings.themeDescription')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <ScreenSegmentedControl
                                        className="mt-4"
                                        activeKey={mode}
                                        onChange={(nextMode) => setTheme(nextMode as typeof mode)}
                                        options={themeOptions}
                                    />
                                </ScreenCard>

                                <SettingsNavCard
                                    title={t('settings.language')}
                                    description={t('settings.languageDescription')}
                                    iconName="language"
                                    iconWrapClassName="bg-primary-500/10 dark:bg-primary-500/20"
                                    iconClassName="text-primary-500"
                                    trailingText={settings.language === 'en' ? t('settings.languageEnglish') : t('settings.languageRussian')}
                                    onPress={handleLanguagePress}
                                />
                            </ScreenStack>
                        </Box>

                        <Box>
                            <ScreenSectionLabel>{t('settings.systemConfiguration')}</ScreenSectionLabel>
                            <ScreenStack className="mt-2">
                                <SettingsNavCard
                                    title={t('settings.presets')}
                                    description={t('settings.presetsDescription')}
                                    iconName="tune"
                                    iconWrapClassName="bg-warning-500/15 dark:bg-warning-500/20"
                                    iconClassName="text-warning-700 dark:text-warning-200"
                                    onPress={handlePresetsPress}
                                />
                                <SettingsNavCard
                                    title={t('settings.storageManager')}
                                    description={t('settings.storageManagerDescription')}
                                    iconName="storage"
                                    iconWrapClassName="bg-success-500/10 dark:bg-success-500/20"
                                    iconClassName="text-success-600 dark:text-success-300"
                                    onPress={handleStorageManagerPress}
                                />
                                <SettingsNavCard
                                    title={t('settings.huggingFaceToken')}
                                    description={t('settings.huggingFaceTokenDescription')}
                                    iconName="key"
                                    iconWrapClassName="bg-primary-500/10 dark:bg-primary-500/20"
                                    iconClassName="text-primary-500"
                                    trailingText={hasHuggingFaceToken
                                        ? t('settings.huggingFaceTokenConfigured')
                                        : t('settings.huggingFaceTokenMissing')}
                                    onPress={handleHuggingFaceTokenPress}
                                />
                                <SettingsNavCard
                                    title={t('settings.privacyDisclosures')}
                                    description={t('settings.privacyDisclosuresDescription')}
                                    iconName="security"
                                    iconWrapClassName="bg-primary-500/10 dark:bg-primary-500/20"
                                    iconClassName="text-primary-500"
                                    onPress={handleLegalPress}
                                />
                            </ScreenStack>
                        </Box>

                        <Box>
                            <ScreenSectionLabel>{t('settings.resources')}</ScreenSectionLabel>
                            <ScreenStack className="mt-2" gap="loose">
                                <ScreenCard>
                                    <Box className="flex-row items-start gap-3">
                                        <Box className="h-11 w-11 items-center justify-center rounded-2xl bg-primary-500/10 dark:bg-primary-500/20">
                                            <MaterialSymbols name="memory" size={20} className="text-primary-500" />
                                        </Box>
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.memoryTitle')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t(isSystemRamSource ? 'settings.memoryDescription' : 'settings.memoryDescriptionFallback')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <Box className="mt-5 flex-row items-start justify-between gap-4">
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-[28px] font-extrabold tracking-tight text-typography-900 dark:text-typography-100">
                                                {ramPrimaryValue}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {ramPrimaryLabel}
                                            </Text>
                                        </Box>

                                        <ScreenCard
                                            variant="inset"
                                            padding="compact"
                                            className="min-w-[110px] self-start"
                                            style={{ backgroundColor: resourceAsideBackground }}
                                        >
                                            <Text className="text-2xs font-semibold uppercase tracking-[0.18em] text-typography-500 dark:text-typography-400">
                                                {ramAsideLabel}
                                            </Text>
                                            <Text className="mt-2 text-base font-extrabold text-primary-500">
                                                {ramAsideValue}
                                            </Text>
                                        </ScreenCard>
                                    </Box>

                                    <ScreenStack className="mt-5" gap="default">
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
                                        ) : (
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
                                        )}
                                    </ScreenStack>

                                    {canForceUnloadModel ? (
                                        <Box className="mt-5 border-t border-outline-200 pt-4 dark:border-outline-800">
                                            <Button
                                                onPress={unloadActiveModel}
                                                accessibilityRole="button"
                                                disabled={false}
                                                action="softDestructive"
                                                size="sm"
                                                className="self-start"
                                            >
                                                <MaterialSymbols name="close" size={18} className="text-error-500" />
                                                <ButtonText>{t('settings.forceUnloadModel')}</ButtonText>
                                            </Button>
                                        </Box>
                                    ) : null}
                                </ScreenCard>

                                <ScreenCard>
                                    <Box className="flex-row items-start gap-3">
                                        <Box className="h-11 w-11 items-center justify-center rounded-2xl bg-success-500/10 dark:bg-success-500/20">
                                            <MaterialSymbols name="storage" size={20} className="text-success-600 dark:text-success-300" />
                                        </Box>
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.storageTitle')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t('settings.storageDescription')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <Box className="mt-5 flex-row items-start justify-between gap-4">
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-[28px] font-extrabold tracking-tight text-typography-900 dark:text-typography-100">
                                                {formatSystemCapacity(storageUsedBytes)}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t('settings.storageUsedOf', { total: formatSystemCapacity(storageTotalBytes) })}
                                            </Text>
                                        </Box>

                                        <ScreenCard
                                            variant="inset"
                                            padding="compact"
                                            className="min-w-[110px] self-start"
                                            style={{ backgroundColor: resourceAsideBackground }}
                                        >
                                            <Text className="text-2xs font-semibold uppercase tracking-[0.18em] text-typography-500 dark:text-typography-400">
                                                {t('settings.free')}
                                            </Text>
                                            <Text className="mt-2 text-base font-extrabold text-success-600 dark:text-success-300">
                                                {formatSystemCapacity(storageFreeBytes)}
                                            </Text>
                                        </ScreenCard>
                                    </Box>

                                    <Box className="mt-5">
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
                                    </Box>
                                </ScreenCard>
                            </ScreenStack>
                        </Box>
                    </ScreenStack>
                </ScreenContent>
            </ScrollView>
        </Box>
    );
};
